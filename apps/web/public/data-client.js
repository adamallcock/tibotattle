/**
 * Browser data boundary.
 *
 * Local companion contract:
 *   GET  /api/local/{onboarding,overview,gradient,weekly,quality}
 *   POST /api/local/refresh/quick (automatic/lightweight observation refresh)
 *   POST /api/local/refresh       (explicit detailed-accounting rebuild)
 *
 * Hosted browser-session contract:
 *   GET  /api/v1/session
 *   POST /api/v1/enroll and /api/v1/logout
 *   POST /api/v1/identity/{google,apple}/{start,result}
 *   POST /api/v1/me/device-pairings
 *
 * The normalizers below accept complete, partial, stale, and insufficient
 * responses, but never silently turn a failure into real-looking data.
 */

import {
  codexCacheReasoningConfiguration,
  REVIEWED_CODEX_MODEL_IDS,
  TELEMETRY_PLAN_TYPES,
  TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION,
  TELEMETRY_V11_ACCOUNT_BASES,
  TELEMETRY_V11_PLAN_BASES,
  telemetryV11RequiredConsent,
} from "./telemetry-shared.generated.js";

export {
  COMMUNITY_SNAPSHOT_SCHEMA_VERSION,
  SUPPORTED_COMMUNITY_SNAPSHOT_SCHEMA_VERSIONS,
  normalizeCommunitySnapshot,
} from "./community-data.js";

const LOCAL_ROOT = "/api/local";
const CENTRAL_ROOT = "/api/v1";
// The dashboard has no tool-activity view. Keep this diagnostic in the raw
// companion payload and retained snapshots, but omit it from display warnings.
const INTERNAL_TOOL_HISTORY_WARNING =
  "Usage accounting is complete, but typed tool history is partial. Tool totals are withheld rather than reported as zero.";
// Provider quota identifiers are protocol values, not display copy. Keep the
// normal Codex allowance selection bound to the exact technical identifier so
// a translated UI label (or another product's weekly-looking window) can never
// be mistaken for it.
export const CODEX_PRIMARY_LIMIT_ID = "codex";
export const CODEX_SPARK_LIMIT_ID = "codex_bengalfox";
// The Spark allowance is reported as `codex_bengalfox` on the wire today;
// `codex-spark` is the marketing token the companion reserves in case the
// provider stabilizes on it later (mirrors SPARK_QUOTA_LIMIT_IDS in
// src/local-companion-usage-model.js). Both identify the same separate Spark
// limit; neither is ever rewritten into the other.
export const CODEX_SPARK_RESERVED_LIMIT_ID = "codex-spark";
export const CODEX_SPARK_LIMIT_IDS = Object.freeze([
  CODEX_SPARK_LIMIT_ID,
  CODEX_SPARK_RESERVED_LIMIT_ID
]);
export const CODEX_FIVE_HOUR_ALLOWANCE_MINUTES = 300;
export const CODEX_WEEKLY_ALLOWANCE_MINUTES = 10_080;
export const MAX_QUOTA_WINDOW_DURATION_MINUTES = 525_600;
export const MAX_QUOTA_LIMIT_DISPLAY_NAME_LENGTH = 80;
export const QUOTA_LIMIT_DISPLAY_ALIASES = Object.freeze({
  [CODEX_PRIMARY_LIMIT_ID]: "Codex",
  [CODEX_SPARK_LIMIT_ID]: "Spark",
  [CODEX_SPARK_RESERVED_LIMIT_ID]: "Spark",
});
const SAFE_QUOTA_LIMIT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const SAFE_QUOTA_LIMIT_DISPLAY_NAME =
  /^[\p{L}\p{N}][\p{L}\p{N}\p{M}\p{Pd} ._()+:]{0,79}$/u;

export function isSparkQuotaLimitId(value) {
  return CODEX_SPARK_LIMIT_IDS.includes(value);
}
// Parse-only compatibility for historical readiness fixtures. The public
// browser relay no longer forwards /api/ready.
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
// The comparison is derived from a sealed snapshot, so it inherits the same
// immutability and every released aggregate contract it can interpret.
export const SUPPORTED_PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSIONS =
  Object.freeze([
    "participant-community-comparison-v0.1",
    PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION
  ]);
const PARTICIPANT_COMPARISON_PLAN_COHORT_VERSIONS = new Set([
  PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSION
]);
export const CONTRIBUTION_SYNC_STATUS_SCHEMA_VERSION =
  "contribution-sync-status-v0.1";
export const CONTRIBUTION_SYNC_PREVIEW_SCHEMA_VERSION =
  "contribution-sync-preview-v0.1";
export const CONTRIBUTION_SYNC_RUN_SCHEMA_VERSION =
  "contribution-sync-run-v0.1";
export const LOCAL_CONTRIBUTION_PREPARATION_RESULT_VERSION =
  "local-contribution-preparation-result-v0.1";
export const LOCAL_CONTRIBUTION_DEVICE_PAIRING_VERSION =
  "local-contribution-device-pairing-v0.1";
export const LOCAL_ONBOARDING_SCHEMA_VERSION = "local-onboarding-v0.2";
export const LOCAL_COMPANION_SCHEMA_VERSION = "local-companion-v0.1";
const MAXIMUM_ONBOARDING_ROLLOUT_FILES = 100;

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
// Parse-only compatibility for historical deletion receipts. No current
// browser method calls the retired granular contribution-delete endpoint.
const CONTRIBUTION_ID_PATTERN =
  /^contribution:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// The Worker returns one of these in every error body. It identifies a server
// request, never a participant, so it is safe to show next to the local
// reference the page mints for the same failure.
const SERVICE_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const LOCAL_DIAGNOSTIC_NOTE_SCHEMA_VERSION =
  "local-diagnostic-note-v0.1";
export const LOCAL_CONTRIBUTION_DIAGNOSTICS_SCHEMA_VERSION =
  "local-contribution-diagnostics-v0.1";
export const HOSTED_SIGNIN_HANDOFF_SCHEMA_VERSION =
  "local-hosted-signin-handoff-v1";
export const LOCAL_CONTRIBUTION_DEVICE_RESET_VERSION =
  "local-contribution-device-reset-v0.1";
export const LOCAL_CONTRIBUTION_DEVICE_DISCONNECT_VERSION =
  "local-contribution-device-disconnect-v0.1";
const DIAGNOSTIC_REFERENCE_PATTERN = /^TT-[0-9A-HJKMNP-TV-Z]{6}$/u;
// Both boundaries answer with fixed identifier-shaped codes: the Worker uses
// SCREAMING_SNAKE, the local companion uses lower_snake. Neither shape can
// carry a sentence, a path, or a quoted value, so a code that matches is safe
// to branch on and to record locally. It is still never rendered as copy: the
// page only ever shows a sentence it wrote itself.
const SAFE_ERROR_CODE_PATTERN =
  /^(?:[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9_]{1,63})$/u;
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
export const IDENTITY_GOOGLE_START_SCHEMA_VERSION =
  "identity-google-start-v0.1";
export const IDENTITY_GOOGLE_RESULT_SCHEMA_VERSION =
  "identity-google-result-v0.1";
export const IDENTITY_APPLE_START_SCHEMA_VERSION =
  "identity-apple-start-v0.1";
export const IDENTITY_APPLE_RESULT_SCHEMA_VERSION =
  "identity-apple-result-v0.1";
const HOSTED_IDENTITY_PROVIDERS = new Set(["google", "apple"]);
const HOSTED_IDENTITY_ERROR_CODES = new Set([
  "IDENTITY_REQUIRED",
  "IDENTITY_TOKEN_INVALID",
  "IDENTITY_CONFIGURATION_INVALID",
  "IDENTITY_PROVIDER_UNAVAILABLE",
  "IDENTITY_RESULT_PENDING"
]);
const HOSTED_SIGNIN_STATE = /^[A-Za-z0-9_-]{43,128}$/u;
// The initiating client generates this verifier, keeps it, and sends only its
// SHA-256 digest to the start route. It re-presents the raw verifier to collect
// the result and again when enrollment consumes the proof, so the unguessable
// state alone — which transits the provider, the browser, and any log — is no
// longer sufficient to redeem a completed sign-in.
const HOSTED_SIGNIN_VERIFIER = /^[A-Za-z0-9_-]{43,128}$/u;

function randomHostedSignInVerifier() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(48));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function hostedSignInBinding(verifier) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  ));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
// The only two URLs this page will ever hand to window.open for sign-in. The
// service builds them; this is the check that it built the one it claimed to.
const APPLE_AUTHORIZE_URL_PREFIX =
  "https://appleid.apple.com/auth/authorize?";
const GOOGLE_AUTHORIZE_URL_PREFIX =
  "https://accounts.google.com/o/oauth2/v2/auth?";
const HOSTED_IDENTITY_LABELS = Object.freeze({
  apple: "Apple",
  google: "Google"
});
const HOSTED_IDENTITY_START_ROUTES = Object.freeze({
  apple: Object.freeze({
    path: "/identity/apple/start",
    schemaVersion: IDENTITY_APPLE_START_SCHEMA_VERSION,
    authorizePrefix: APPLE_AUTHORIZE_URL_PREFIX
  }),
  google: Object.freeze({
    path: "/identity/google/start",
    schemaVersion: IDENTITY_GOOGLE_START_SCHEMA_VERSION,
    authorizePrefix: GOOGLE_AUTHORIZE_URL_PREFIX
  })
});
const HOSTED_IDENTITY_RESULT_ROUTES = Object.freeze({
  apple: Object.freeze({
    path: "/identity/apple/result",
    schemaVersion: IDENTITY_APPLE_RESULT_SCHEMA_VERSION
  }),
  google: Object.freeze({
    path: "/identity/google/result",
    schemaVersion: IDENTITY_GOOGLE_RESULT_SCHEMA_VERSION
  })
});
const LOCAL_PREPARATION_ERROR_CODES = new Set([
  "coverage_unavailable",
  "coverage_invalid",
  "identity_unavailable",
  "identity_migration_required",
  "no_safe_records",
  "export_too_large",
  "privacy_verification_failed",
  "review_archive_invalid",
  "prepared_spool_invalid",
  "preparation_in_progress",
  "preparation_failed",
  "consent_already_current"
]);

/**
 * A resource-bounded preparation failure carries the bound it stopped on: an
 * identifier-shaped code and two counts, nothing else. It is read back under
 * the same shape test the companion applies so nothing but a code and numbers
 * can be shown to the reader or filed against a reference.
 */
function preparationDetail(value) {
  if (typeof value?.code !== "string"
      || !SAFE_ERROR_CODE_PATTERN.test(value.code)) {
    return null;
  }
  const count = (candidate) =>
    Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
  return Object.freeze({
    code: value.code,
    observed: count(value.observed),
    limit: count(value.limit)
  });
}

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

function normalizePlanType(value) {
  const candidate = text(value, "unknown");
  return TELEMETRY_PLAN_TYPES.includes(candidate) ? candidate : "unknown";
}

function canonicalInstant(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
    ? value
    : null;
}

function normalizeQuotaLimitId(value) {
  return sanitizeQuotaLimitId(value);
}

export function sanitizeQuotaLimitId(value) {
  return typeof value === "string" && SAFE_QUOTA_LIMIT_ID.test(value)
    ? value
    : "unknown";
}

export function sanitizeQuotaLimitDisplayName(value) {
  if (typeof value !== "string") return null;
  let normalized;
  try {
    normalized = value.normalize("NFKC").trim();
  } catch {
    return null;
  }
  if (normalized.length === 0
      || Array.from(normalized).length > MAX_QUOTA_LIMIT_DISPLAY_NAME_LENGTH
      || !SAFE_QUOTA_LIMIT_DISPLAY_NAME.test(normalized)) {
    return null;
  }
  return normalized;
}

export function quotaLimitDisplayAlias(limitId) {
  const normalized = sanitizeQuotaLimitId(limitId);
  return Object.hasOwn(QUOTA_LIMIT_DISPLAY_ALIASES, normalized)
    ? QUOTA_LIMIT_DISPLAY_ALIASES[normalized]
    : null;
}

/**
 * True only for the provider's normal Codex allowance track. `primary` here
 * names the limit identifier, not its UI slot: either provider slot can carry
 * a valid normal Codex window. This deliberately does not inspect labels.
 */
export function isPrimaryCodexQuotaWindow(window) {
  return window?.limitId === CODEX_PRIMARY_LIMIT_ID
    && isValidQuotaWindowDuration(finite(window?.durationMinutes));
}

export function isPrimaryCodexWeeklyQuotaWindow(window) {
  return window?.limitId === CODEX_PRIMARY_LIMIT_ID
    && finite(window?.durationMinutes) === CODEX_WEEKLY_ALLOWANCE_MINUTES;
}

export function isValidQuotaWindowDuration(value) {
  return Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_QUOTA_WINDOW_DURATION_MINUTES;
}

export function selectPrimaryCodexQuotaWindow(windows) {
  let selected = null;
  for (const window of Array.isArray(windows) ? windows : []) {
    if (!isPrimaryCodexQuotaWindow(window)) continue;
    if (selected === null) {
      selected = window;
      continue;
    }
    const durationMinutes = finite(window.durationMinutes);
    const selectedDurationMinutes = finite(selected.durationMinutes);
    if (durationMinutes > selectedDurationMinutes
        || (durationMinutes === selectedDurationMinutes
          && window.slot === "primary"
          && selected.slot !== "primary")) {
      selected = window;
    }
  }
  return selected;
}

export function formatQuotaWindowDuration(durationMinutes) {
  const duration = finite(durationMinutes, null);
  if (!isValidQuotaWindowDuration(duration)) return "";
  if (duration % (24 * 60) === 0) return `${duration / (24 * 60)}-day`;
  if (duration % 60 === 0) return `${duration / 60}-hour`;
  return `${duration}-minute`;
}

// Every window kind this product names, mapped from the provider's technical
// identity (limitId, durationMinutes) alone — never from a provider label
// string. The 5-hour Spark window ("Codex Spark") arrives on the wire as
// limit_id "codex_bengalfox" with window_minutes 300 alongside the Spark
// seven-day window (observed 2026-08-19, when the provider re-introduced it).
// An unrecognized combination classifies as an honest generic kind rather
// than borrowing the weekly or five-hour identity.
export const QUOTA_WINDOW_KINDS = Object.freeze([
  "codex_five_hour",
  "codex_seven_day",
  "codex_provider_reported",
  "spark_five_hour",
  "spark_seven_day",
  "spark_other",
  "other"
]);

export function classifyQuotaWindowKind(limitId, durationMinutes) {
  const duration = finite(durationMinutes, null);
  if (!isValidQuotaWindowDuration(duration)) return "other";
  if (limitId === CODEX_PRIMARY_LIMIT_ID) {
    if (duration === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES) return "codex_five_hour";
    if (duration === CODEX_WEEKLY_ALLOWANCE_MINUTES) return "codex_seven_day";
    return "codex_provider_reported";
  }
  if (isSparkQuotaLimitId(limitId)) {
    if (duration === CODEX_FIVE_HOUR_ALLOWANCE_MINUTES) return "spark_five_hour";
    if (duration === CODEX_WEEKLY_ALLOWANCE_MINUTES) return "spark_seven_day";
    // The limit identity is certain even when a valid duration is novel, so
    // the window keeps the generic Spark name rather than borrowing a named
    // duration.
    return "spark_other";
  }
  return "other";
}

export function quotaWindowLabel(limitId, durationMinutes, limitName = null) {
  const duration = finite(durationMinutes, null);
  switch (classifyQuotaWindowKind(limitId, duration)) {
    case "codex_five_hour":
      return "Five-hour allowance";
    case "codex_seven_day":
      return "Seven-day allowance";
    case "codex_provider_reported":
      return `Provider-reported ${formatQuotaWindowDuration(duration)} window`;
    case "spark_five_hour":
      return "Spark five-hour allowance";
    case "spark_seven_day":
      return "Spark seven-day allowance";
    case "spark_other":
      return "Spark allowance";
    default:
      break;
  }
  const durationLabel = formatQuotaWindowDuration(duration);
  const providerName = sanitizeQuotaLimitDisplayName(limitName);
  if (durationLabel === "") {
    return providerName === null
      ? "Other observed allowance"
      : `${providerName} allowance`;
  }
  return providerName === null
    ? `Other observed ${durationLabel} allowance`
    : `${providerName} · ${durationLabel} allowance`;
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

function validHostedIdentity(identity) {
  return hasExactKeys(identity, ["provider", "proof", "verifier"])
    && HOSTED_IDENTITY_PROVIDERS.has(identity.provider)
    && typeof identity.proof === "string"
    && /^[A-Za-z0-9_-]{64}$/u.test(identity.proof)
    && typeof identity.verifier === "string"
    && HOSTED_SIGNIN_VERIFIER.test(identity.verifier);
}

/**
 * Carry the service's own request id onto a rejected request.
 *
 * The Worker mints one UUID per request and returns it in every error body.
 * Nothing else from the body is retained: the message stays fixed, and only a
 * value with exactly the minted shape is kept, so no server string can reach
 * the page through this path.
 */
function attachServiceRequestId(error, payload) {
  const candidate = payload?.error?.requestId;
  if (typeof candidate === "string"
      && SERVICE_REQUEST_ID_PATTERN.test(candidate)) {
    error.requestId = candidate;
  }
  return error;
}

/**
 * Reject a local companion mutation while preserving its fixed error code.
 *
 * The body must be exactly {schemaVersion, error:{code}} and the code must be
 * identifier-shaped, so an unexpected companion response drops back to a
 * codeless rejection instead of handing the page something to trust.
 */
function localCompanionRequestError(response, payload) {
  const error = new Error(`Request failed (${response.status}).`);
  error.status = response.status;
  if (hasExactKeys(payload, ["schemaVersion", "error"])
      && payload.schemaVersion === "local-companion-v0.1"
      && hasExactKeys(payload.error, ["code"])
      && typeof payload.error.code === "string"
      && SAFE_ERROR_CODE_PATTERN.test(payload.error.code)) {
    error.code = payload.error.code;
  }
  return error;
}

// The local relay to the contribution service answers with its own fixed
// central_participant_* codes when the relay itself — not the Worker — fails
// (an unreachable service, a bounded-body overflow, a misconfigured origin).
// They are a closed, content-free, lower_snake vocabulary the companion mints,
// so a sign-in result read that fails at the relay can be retried and
// referenced by its real cause instead of being stripped to an empty
// "unknown" that aborts the poll with no diagnostic (owner-reported relay
// identity loss, 2026-08-10). Any other server string is still dropped.
const RELAY_TRANSPORT_ERROR_CODE_PATTERN = /^central_participant_[a-z0-9_]{1,48}$/u;

function hostedIdentityRequestError(response, payload) {
  const error = new Error(`Request failed (${response.status}).`);
  error.status = response.status;
  const code = payload?.error?.code;
  if (typeof code === "string"
      && (HOSTED_IDENTITY_ERROR_CODES.has(code)
        || RELAY_TRANSPORT_ERROR_CODE_PATTERN.test(code))) {
    error.code = code;
  }
  return attachServiceRequestId(error, payload);
}

/**
 * Starts a hosted sign-in. Both providers work the same way: the service owns
 * the redirect target and the client secret, so this page only ever learns an
 * unguessable state and the authorize URL to open. No authorization code, PKCE
 * verifier, or redirect URI is ever held here.
 */
async function startHostedSignIn(fetchImpl, provider) {
  const { path, schemaVersion, authorizePrefix } =
    HOSTED_IDENTITY_START_ROUTES[provider];
  // The verifier stays on this client; only its digest is sent to the service.
  const verifier = randomHostedSignInVerifier();
  const binding = await hostedSignInBinding(verifier);
  const response = await fetchImpl(`${CENTRAL_ROOT}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ binding })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw hostedIdentityRequestError(response, payload);
  }
  if (payload?.schemaVersion !== schemaVersion
      || typeof payload?.state !== "string"
      || !HOSTED_SIGNIN_STATE.test(payload.state)
      || typeof payload?.authorizeUrl !== "string"
      || !payload.authorizeUrl.startsWith(authorizePrefix)) {
    throw new Error(
      `The service did not return a usable ${HOSTED_IDENTITY_LABELS[provider]} sign-in request.`
    );
  }
  return Object.freeze({
    state: payload.state,
    authorizeUrl: payload.authorizeUrl,
    verifier
  });
}

/**
 * Reads a completed sign-in back exactly once. A pending sign-in surfaces as
 * IDENTITY_RESULT_PENDING so the caller can keep polling without treating it
 * as a failure.
 */
async function readHostedSignInResult(fetchImpl, provider, state, verifier) {
  const { path, schemaVersion } = HOSTED_IDENTITY_RESULT_ROUTES[provider];
  if (typeof state !== "string" || !HOSTED_SIGNIN_STATE.test(state)) {
    throw new TypeError(
      `${HOSTED_IDENTITY_LABELS[provider]} sign-in state is invalid.`
    );
  }
  if (typeof verifier !== "string" || !HOSTED_SIGNIN_VERIFIER.test(verifier)) {
    throw new TypeError(
      `${HOSTED_IDENTITY_LABELS[provider]} sign-in verifier is invalid.`
    );
  }
  const response = await fetchImpl(`${CENTRAL_ROOT}${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ state, verifier })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw hostedIdentityRequestError(response, payload);
  }
  if (payload?.schemaVersion !== schemaVersion
      || typeof payload?.proof !== "string"
      || !/^[A-Za-z0-9_-]{64}$/u.test(payload.proof)) {
    throw new Error(
      `The service did not return a usable ${HOSTED_IDENTITY_LABELS[provider]} sign-in proof.`
    );
  }
  // The verifier is echoed back with the proof so enrollment can carry the
  // initiator binding through to proof consumption.
  return Object.freeze({ provider, proof: payload.proof, verifier });
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

// The bounded incremental-status projection the approve-once surface reads:
// consent verdict, day-count progress, pause reason and last outcome as
// fixed-vocabulary codes. Anything else in the payload fails the read closed.
const INCREMENTAL_SYNC_STATUS_SCHEMA_VERSION =
  "local-incremental-contribution-sync-v1.0";
const INCREMENTAL_SYNC_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const INCREMENTAL_SYNC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
// Where a macOS Keychain dialog is still reachable for this install. An
// unreadable or absent answer means "pairing" — today's guidance, shown to
// everyone — so a companion that cannot say never silently withholds it.
const INCREMENTAL_SYNC_KEYCHAIN_PROMPTS = ["pairing", "migration", "none"];

export function normalizeIncrementalContributionSyncStatus(payload) {
  const keychainPrompt =
    INCREMENTAL_SYNC_KEYCHAIN_PROMPTS.includes(payload?.keychainPrompt)
      ? payload.keychainPrompt
      : "pairing";
  const unavailable = Object.freeze({
    status: "unavailable",
    keychainPrompt,
    consent: Object.freeze({ approved: false, current: false, consentedAt: "" }),
    paused: false,
    pausedReason: null,
    running: false,
    progress: null,
    lastAttemptAt: "",
    nextAttemptAt: "",
    lastOutcome: null
  });
  if (payload?.schemaVersion !== INCREMENTAL_SYNC_STATUS_SCHEMA_VERSION
      || payload?.status !== "available"
      || typeof payload?.paused !== "boolean"
      || typeof payload?.running !== "boolean"
      || typeof payload?.consent?.approved !== "boolean"
      || typeof payload?.consent?.current !== "boolean"
      || payload?.includesContent !== false
      || payload?.includesPaths !== false
      || payload?.includesIdentifiers !== false
      || payload?.includesCredentials !== false) {
    return unavailable;
  }
  const consentedAt = text(payload.consent.consentedAt, "");
  const lastAttemptAt = text(payload.lastAttemptAt, "");
  const nextAttemptAt = text(payload.nextAttemptAt, "");
  if ((consentedAt && !Number.isFinite(Date.parse(consentedAt)))
      || (lastAttemptAt && !Number.isFinite(Date.parse(lastAttemptAt)))
      || (nextAttemptAt && !Number.isFinite(Date.parse(nextAttemptAt)))) {
    return unavailable;
  }
  const rawProgress = payload.progress;
  let progress = null;
  if (rawProgress !== null && rawProgress !== undefined) {
    const daysTotal = count(rawProgress.daysTotal, null);
    const daysSynced = count(rawProgress.daysSynced, null);
    const daysPending = count(rawProgress.daysPending, null);
    const chunksUploaded = count(rawProgress.chunksUploaded, null);
    const acknowledgedThroughDay = rawProgress.acknowledgedThroughDay ?? null;
    if (daysTotal === null || daysSynced === null || daysPending === null
        || chunksUploaded === null
        || (acknowledgedThroughDay !== null
          && !INCREMENTAL_SYNC_DAY_PATTERN.test(acknowledgedThroughDay))) {
      return unavailable;
    }
    progress = Object.freeze({
      daysTotal,
      daysSynced,
      daysPending,
      chunksUploaded,
      acknowledgedThroughDay
    });
  }
  const rawOutcome = payload.lastOutcome;
  let lastOutcome = null;
  if (rawOutcome !== null && rawOutcome !== undefined) {
    if (!Number.isFinite(Date.parse(rawOutcome.at ?? ""))
        || !INCREMENTAL_SYNC_CODE_PATTERN.test(rawOutcome.code ?? "")
        || !["succeeded", "partial", "failed", "paused"].includes(rawOutcome.status)) {
      return unavailable;
    }
    lastOutcome = Object.freeze({
      at: rawOutcome.at,
      code: rawOutcome.code,
      status: rawOutcome.status
    });
  }
  return Object.freeze({
    status: "available",
    keychainPrompt,
    ...(payload.contractVersion === TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION
      ? { contractVersion: payload.contractVersion } : {}),
    ...(payload.attributionUpgrade?.available === true
      && payload.attributionUpgrade?.contractVersion === TELEMETRY_V11_CONTRIBUTION_SCHEMA_VERSION
      ? { attributionUpgradeAvailable: true } : {}),
    consent: Object.freeze({
      approved: payload.consent.approved,
      current: payload.consent.current,
      consentedAt
    }),
    paused: payload.paused,
    pausedReason: payload.paused
      && INCREMENTAL_SYNC_CODE_PATTERN.test(payload.pausedReason ?? "")
      ? payload.pausedReason
      : null,
    running: payload.running,
    progress,
    lastAttemptAt,
    nextAttemptAt,
    lastOutcome
  });
}

export function normalizeAttributionContributionReview(payload) {
  const required = telemetryV11RequiredConsent();
  const consent = payload?.consent;
  const inventory = payload?.inventory;
  const fields = inventory?.fields;
  let destination;
  try { destination = new URL(consent?.destinationOrigin); } catch { return null; }
  const loopback = destination.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname);
  if (payload?.schemaVersion !== "local-incremental-contribution-review-v1.1" || payload.status !== "ready"
      || payload.includesContent !== false || payload.includesPaths !== false
      || payload.includesAccountIdentifiers !== false || payload.includesCredentials !== false
      || !/^[A-Za-z0-9_-]{43}$/u.test(payload.reviewToken ?? "")
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(payload.grantDeviceId ?? "")
      || (destination.protocol !== "https:" && !loopback) || destination.origin !== consent.destinationOrigin
      || !consent || Object.keys(consent).length !== 4
      || Object.entries(required).some(([key, value]) => consent[key] !== value || inventory?.consent?.[key] !== value)
      || inventory?.schemaVersion !== "telemetry-field-inventory-v1.1"
      || !/^[0-9a-f]{64}$/u.test(inventory.inventoryDigest ?? "")
      || !fields || Object.keys(fields).length !== 4
      || ["usage", "quota", "session", "accountPlanAttribution"].some((stream) =>
        !Array.isArray(fields[stream]) || fields[stream].length < 1 || fields[stream].length > 40
        || fields[stream].some((field) => typeof field !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(field)))
      || JSON.stringify(inventory.accountBases) !== JSON.stringify(TELEMETRY_V11_ACCOUNT_BASES)
      || JSON.stringify(inventory.planBases) !== JSON.stringify(TELEMETRY_V11_PLAN_BASES)
      || JSON.stringify(inventory.nullableQuotaMeasurements) !== JSON.stringify(["usedPercent", "windowDurationMinutes", "resetsAt"])
      || !INCREMENTAL_SYNC_DAY_PATTERN.test(payload.sample?.day ?? "")
      || !/^[0-9a-f]{64}$/u.test(payload.sample?.manifestDigest ?? "")
      || ["usage", "quota", "session"].some((stream) => count(payload.sample?.recordCounts?.[stream], null) === null)
      || typeof payload.hostedConsentCurrent !== "boolean") return null;
  return Object.freeze({
    reviewToken: payload.reviewToken, grantDeviceId: payload.grantDeviceId,
    consent: Object.freeze({ ...required, destinationOrigin: destination.origin }),
    inventory: Object.freeze({ inventoryDigest: inventory.inventoryDigest,
      fields: Object.freeze(Object.fromEntries(["usage", "quota", "session", "accountPlanAttribution"]
        .map((stream) => [stream, Object.freeze([...fields[stream]])]))),
      accountBases: Object.freeze([...inventory.accountBases]), planBases: Object.freeze([...inventory.planBases]),
      nullableQuotaMeasurements: Object.freeze([...inventory.nullableQuotaMeasurements]),
    }),
    sample: Object.freeze({ day: payload.sample.day, manifestDigest: payload.sample.manifestDigest,
      recordCounts: Object.freeze(Object.fromEntries(["usage", "quota", "session"]
        .map((stream) => [stream, payload.sample.recordCounts[stream]]))) }),
    hostedConsentCurrent: payload.hostedConsentCurrent,
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
    && ["current_api_prices", "historical_api_prices", "unpriced", "mixed_api_prices"]
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

export const LOCAL_WINDOW_BREAKDOWN_SCHEMA_VERSION = "local-window-breakdown-v0.1";

function windowBreakdownSpeedRow(value) {
  return {
    costUsd: nonNegative(value?.costUsd, 0),
    tokens: count(value?.tokens, 0),
    events: count(value?.events, 0),
    unpricedEvents: count(value?.unpricedEvents, 0),
    unpricedShare: nonNegative(value?.unpricedShare, 0),
  };
}

/**
 * The per-model / per-speed cost mix for one bounded window, sanitized to
 * content-free numbers. A missing or unavailable breakdown reads back as an
 * explicit unavailable status rather than an empty-but-priced mix, so the panel
 * can tell "nothing here" apart from "we could not read it".
 */
export function normalizeWindowBreakdown(payload) {
  const unavailable = {
    status: "unavailable",
    from: null,
    to: null,
    events: 0,
    unpricedShare: 0,
    costUsd: 0,
    tokens: 0,
    fastCostUsd: 0,
    fastEvents: 0,
    byModel: [],
    bySpeed: {},
    spark: { events: 0, costUsd: 0 },
  };
  const breakdown = payload?.breakdown;
  if (payload?.schemaVersion !== LOCAL_COMPANION_SCHEMA_VERSION
      || breakdown === null
      || typeof breakdown !== "object"
      || Array.isArray(breakdown)) {
    return unavailable;
  }
  if (breakdown.status !== "available") {
    return { ...unavailable, status: text(breakdown.status, "unavailable") };
  }
  const byModel = (Array.isArray(breakdown.byModel) ? breakdown.byModel : [])
    .filter((row) => typeof row?.model === "string" && row.model.length > 0)
    .map((row) => ({
      model: row.model,
      costUsd: nonNegative(row.costUsd, 0),
      tokens: count(row.tokens, 0),
      events: count(row.events, 0),
      unpricedEvents: count(row.unpricedEvents, 0),
      unpricedShare: nonNegative(row.unpricedShare, 0),
      fastModeMultiplier: finite(row.fastModeMultiplier, null),
    }));
  const bySpeed = {};
  const rawSpeed = breakdown.bySpeed;
  if (rawSpeed && typeof rawSpeed === "object" && !Array.isArray(rawSpeed)) {
    for (const [speed, value] of Object.entries(rawSpeed)) {
      if (typeof speed !== "string" || speed.length === 0) continue;
      bySpeed[speed] = windowBreakdownSpeedRow(value);
    }
  }
  return {
    status: "available",
    from: count(breakdown.from, null),
    to: count(breakdown.to, null),
    events: count(breakdown.events, 0),
    unpricedShare: nonNegative(breakdown.unpricedShare, 0),
    costUsd: nonNegative(breakdown.costUsd, 0),
    tokens: count(breakdown.tokens, 0),
    fastCostUsd: nonNegative(breakdown.fastCostUsd, 0),
    fastEvents: count(breakdown.fastEvents, 0),
    byModel,
    bySpeed,
    spark: {
      events: count(breakdown.spark?.events, 0),
      costUsd: nonNegative(breakdown.spark?.costUsd, 0),
    },
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

export function normalizeLocalDiagnosticNote(payload) {
  const unavailable = { status: "unavailable", reference: "" };
  if (payload?.schemaVersion !== LOCAL_DIAGNOSTIC_NOTE_SCHEMA_VERSION
      || payload?.status !== "recorded"
      || !DIAGNOSTIC_REFERENCE_PATTERN.test(payload?.reference ?? "")) {
    return unavailable;
  }
  return { status: "recorded", reference: payload.reference };
}

const HOSTED_SIGNIN_HANDOFF_BOUND_VALUE = /^[A-Za-z0-9_-]{43,128}$/u;

export function normalizeHostedSignInHandoff(payload) {
  const unavailable = Object.freeze({
    status: "unavailable",
    provider: null,
    state: null,
    verifier: null,
    startedAt: null,
    expiresAt: null,
  });
  if (hasExactKeys(payload, ["schemaVersion", "status"])
      && payload.schemaVersion === HOSTED_SIGNIN_HANDOFF_SCHEMA_VERSION
      && payload.status === "absent") {
    return Object.freeze({ ...unavailable, status: "absent" });
  }
  if (hasExactKeys(payload, ["schemaVersion", "status", "provider"])
      && payload.schemaVersion === HOSTED_SIGNIN_HANDOFF_SCHEMA_VERSION
      && payload.status === "expired"
      && ["google", "apple"].includes(payload.provider)) {
    return Object.freeze({
      ...unavailable,
      status: "expired",
      provider: payload.provider,
    });
  }
  if (!hasExactKeys(payload, [
        "schemaVersion",
        "status",
        "provider",
        "state",
        "verifier",
        "startedAt",
        "expiresAt",
      ])
      || payload.schemaVersion !== HOSTED_SIGNIN_HANDOFF_SCHEMA_VERSION
      || payload.status !== "pending"
      || !["google", "apple"].includes(payload.provider)
      || typeof payload.state !== "string"
      || !HOSTED_SIGNIN_HANDOFF_BOUND_VALUE.test(payload.state)
      || typeof payload.verifier !== "string"
      || !HOSTED_SIGNIN_HANDOFF_BOUND_VALUE.test(payload.verifier)
      || !Number.isSafeInteger(payload.startedAt)
      || payload.startedAt < 0
      || !Number.isSafeInteger(payload.expiresAt)
      || payload.expiresAt <= payload.startedAt
      || payload.expiresAt - payload.startedAt !== 15 * 60 * 1_000) {
    return unavailable;
  }
  return Object.freeze({
    status: "pending",
    provider: payload.provider,
    state: payload.state,
    verifier: payload.verifier,
    startedAt: payload.startedAt,
    expiresAt: payload.expiresAt,
  });
}

const CONTRIBUTION_DIAGNOSTIC_PHASES = new Set([
  "not_configured",
  "unavailable",
  "sign_in_required",
  "preparing_review",
  "review_ready",
  "connecting",
  "approved_connection_needed",
  "approved_paused",
  "approved_syncing",
  "approved_idle",
]);
const CONTRIBUTION_DIAGNOSTIC_QUEUE_STATES = new Set([
  "unavailable",
  "empty",
  "ready",
  "retry_wait",
  "paused",
]);
const CONTRIBUTION_DIAGNOSTIC_PREVIEW_STATES = new Set([
  "not_observed",
  ...CONTRIBUTION_DIAGNOSTIC_QUEUE_STATES,
]);

export function normalizeLocalContributionDiagnostics(payload) {
  const unavailable = Object.freeze({
    status: "unavailable",
    journeyPhase: "unavailable",
    previewState: "not_observed",
    queueState: "unavailable",
    consent: Object.freeze({ approved: false, current: false }),
    signedIn: Object.freeze({ observed: false, value: false }),
    pairing: Object.freeze({ observed: false, paired: false }),
    recentDiagnosticReferences: Object.freeze([]),
  });
  const references = payload?.recentDiagnosticReferences;
  if (!hasExactKeys(payload, [
        "schemaVersion",
        "journeyPhase",
        "previewState",
        "queueState",
        "consent",
        "signedIn",
        "pairing",
        "recentDiagnosticReferences",
        "includesTokens",
        "includesOauthState",
        "includesVerifiers",
        "includesDeviceIdentifiers",
        "includesAccountIdentifiers",
        "includesContent",
        "includesPaths",
      ])
      || payload.schemaVersion !== LOCAL_CONTRIBUTION_DIAGNOSTICS_SCHEMA_VERSION
      || !CONTRIBUTION_DIAGNOSTIC_PHASES.has(payload?.journeyPhase)
      || !CONTRIBUTION_DIAGNOSTIC_PREVIEW_STATES.has(payload?.previewState)
      || !CONTRIBUTION_DIAGNOSTIC_QUEUE_STATES.has(payload?.queueState)
      || !hasExactKeys(payload?.consent, ["approved", "current"])
      || typeof payload?.consent?.approved !== "boolean"
      || typeof payload?.consent?.current !== "boolean"
      || !hasExactKeys(payload?.signedIn, ["observed", "value"])
      || typeof payload?.signedIn?.observed !== "boolean"
      || typeof payload?.signedIn?.value !== "boolean"
      || !hasExactKeys(payload?.pairing, ["observed", "paired"])
      || typeof payload?.pairing?.observed !== "boolean"
      || typeof payload?.pairing?.paired !== "boolean"
      || !Array.isArray(references)
      || references.length > 5
      || payload?.includesTokens !== false
      || payload?.includesOauthState !== false
      || payload?.includesVerifiers !== false
      || payload?.includesDeviceIdentifiers !== false
      || payload?.includesAccountIdentifiers !== false
      || payload?.includesContent !== false
      || payload?.includesPaths !== false) {
    return unavailable;
  }
  const normalizedReferences = [];
  for (const value of references) {
    const recordedAt = text(value?.recordedAt, "");
    if (!hasExactKeys(value, ["reference", "recordedAt"])
        || !DIAGNOSTIC_REFERENCE_PATTERN.test(value?.reference ?? "")
        || !Number.isFinite(Date.parse(recordedAt))
        || new Date(Date.parse(recordedAt)).toISOString() !== recordedAt) {
      return unavailable;
    }
    normalizedReferences.push(Object.freeze({
      reference: value.reference,
      recordedAt,
    }));
  }
  return Object.freeze({
    status: "available",
    journeyPhase: payload.journeyPhase,
    previewState: payload.previewState,
    queueState: payload.queueState,
    consent: Object.freeze({
      approved: payload.consent.approved,
      current: payload.consent.current,
    }),
    signedIn: Object.freeze({
      observed: payload.signedIn.observed,
      value: payload.signedIn.value,
    }),
    pairing: Object.freeze({
      observed: payload.pairing.observed,
      paired: payload.pairing.paired,
    }),
    recentDiagnosticReferences: Object.freeze(normalizedReferences),
  });
}

export function normalizeLocalContributionDeviceReset(payload) {
  const unavailable = {
    status: "unavailable",
    credential: "unknown",
    binding: "unknown"
  };
  if (payload?.schemaVersion !== LOCAL_CONTRIBUTION_DEVICE_RESET_VERSION
      || !["reset", "already_absent"].includes(payload?.status)
      || !["deleted", "already_missing"].includes(payload?.credential)
      || !["removed", "already_missing"].includes(payload?.binding)
      // The companion never returns hosted state from this route; a response
      // that claims otherwise is not the contract this page asked for.
      || payload?.hostedDataDeleted !== false
      || payload?.includesIdentifiers !== false) {
    return unavailable;
  }
  return {
    status: payload.status,
    credential: payload.credential,
    binding: payload.binding
  };
}

/**
 * Accept only the deliberately non-identifying result of stopping this Mac's
 * upload authority. The local companion performs the authenticated remote
 * revocation and clears its Keychain/state binding; the browser must never
 * receive the device id or the bearer secret that made that possible.
 */
export function normalizeLocalContributionDeviceDisconnect(payload) {
  const unavailable = {
    status: "unavailable",
    deliveryPaused: false,
    localCredential: "unknown",
    localBinding: "unknown",
  };
  if (!hasExactKeys(payload, [
    "schemaVersion", "status", "deliveryPaused", "localCredential",
    "localBinding", "hostedDataDeleted", "includesIdentifiers", "includesCredentials",
  ])
      || payload?.schemaVersion !== LOCAL_CONTRIBUTION_DEVICE_DISCONNECT_VERSION
      || payload?.status !== "disconnected"
      || payload?.deliveryPaused !== true
      || !["deleted", "already_missing"].includes(payload?.localCredential)
      || payload?.localBinding !== "removed"
      || payload?.hostedDataDeleted !== false
      || payload?.includesIdentifiers !== false
      || payload?.includesCredentials !== false) {
    return unavailable;
  }
  return {
    status: "disconnected",
    deliveryPaused: true,
    localCredential: payload.localCredential,
    localBinding: "removed",
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
    planType: normalizePlanType(payload?.planType),
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
      || !isValidQuotaWindowDuration(windowDurationMinutes)
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
      planType: normalizePlanType(continuity.planType),
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
  if (!SUPPORTED_PARTICIPANT_COMMUNITY_COMPARISON_SCHEMA_VERSIONS.includes(
    payload?.schemaVersion
  )) {
    return unavailable;
  }
  const carriesPlanCohort = PARTICIPANT_COMPARISON_PLAN_COHORT_VERSIONS.has(
    payload.schemaVersion
  );
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
    // v0.1 comparisons predate plan cohorts entirely, so the cohort question
    // has no answer for those cells. "unknown" says that; false would claim
    // the cohort was checked and did not match.
    cells.push({
      provider,
      planType: carriesPlanCohort
        ? text(candidate?.planType, "unknown")
        : "unknown",
      planVariant: carriesPlanCohort
        ? text(candidate?.planVariant, "unknown")
        : "unknown",
      cohortMatchesParticipant: carriesPlanCohort
        ? candidate?.cohortMatchesParticipant === true
        : "unknown",
      modelId,
      participantHasActivity: candidate.participantHasActivity,
      metrics
    });
  }
  return {
    ...unavailable,
    status: "ready",
    reason: "",
    schemaVersion: payload.schemaVersion,
    participantPlanCohort: {
      planType: carriesPlanCohort
        ? text(payload?.participantPlanCohort?.planType, "unknown")
        : "unknown",
      planVariant: carriesPlanCohort
        ? text(payload?.participantPlanCohort?.planVariant, "unknown")
        : "unknown"
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
  // `null` is the service stating that raw envelopes carry no age-based
  // deletion. Any other value must be a positive window the per-contribution
  // schedule below is then checked against; a zero or absent number is a
  // malformed contract rather than "delete immediately".
  const rawQuarantineRetention =
    payload.historyPolicy?.quarantineRetentionMilliseconds;
  const quarantineRetentionMilliseconds = rawQuarantineRetention === null
    ? null
    : count(rawQuarantineRetention, null);
  if (!PARTICIPANT_CONSENT_VERSIONS.has(payload.consentVersion)
      || !Number.isFinite(Date.parse(payload.createdAt))
      || !Array.isArray(payload.contributions)
      || payload.contributions.length > 101
      || count(payload.contributionCount, null) !== payload.contributions.length
      || count(payload.historyPolicy?.maximumItems, null) !== 101
      || (rawQuarantineRetention !== null
        && !(quarantineRetentionMilliseconds > 0))
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
    const scheduledDeletionAt = candidate?.quarantine?.scheduledDeletionAt === null
      ? null
      : text(candidate?.quarantine?.scheduledDeletionAt, "");
    const deletedAt = candidate?.quarantine?.deletedAt === null
      ? null
      : text(candidate?.quarantine?.deletedAt, "");
    const createdEpoch = Date.parse(createdAt);
    const startEpoch = Date.parse(startAt);
    const endEpoch = Date.parse(endAt);
    const scheduledEpoch = scheduledDeletionAt === null
      ? null
      : Date.parse(scheduledDeletionAt);
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
        || (quarantineRetentionMilliseconds === null
          ? scheduledDeletionAt !== null
          : !Number.isFinite(scheduledEpoch)
            || scheduledEpoch !== createdEpoch + quarantineRetentionMilliseconds)
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
    const serverPriceBasis = candidate?.serverAccounting?.priceBasis === undefined
      ? null
      : text(candidate?.serverAccounting?.priceBasis, "");
    const serverPriceEpochBasis = candidate?.serverAccounting?.priceEpochBasis === undefined
      ? null
      : text(candidate?.serverAccounting?.priceEpochBasis, "");
    const serverEventTimeRange = candidate?.serverAccounting?.eventTimeRange;
    const serverEventTimeStart = serverEventTimeRange === null
      || serverEventTimeRange === undefined
      ? null
      : canonicalInstant(serverEventTimeRange?.startAt);
    const serverEventTimeEnd = serverEventTimeRange === null
      || serverEventTimeRange === undefined
      ? null
      : canonicalInstant(serverEventTimeRange?.endAt);
    if (!["server_repriced", "server_repricing_unavailable"].includes(priceVerification)
        || (priceVerification === "server_repriced" && serverPrice === null)
        || (priceVerification === "server_repricing_unavailable"
          && candidate?.serverAccounting?.apiPriceEquivalentUsd !== null)) {
      return unavailable("invalid_contract");
    }
    if ((serverPriceBasis !== null
      && !["historical_api_prices", "unpriced", "mixed_api_prices"].includes(serverPriceBasis))
        || (serverPriceEpochBasis !== null
          && serverPriceEpochBasis !== "event_time_when_registry_has_effective_evidence")
        || (serverEventTimeRange !== null && serverEventTimeRange !== undefined
          && (serverEventTimeStart === null
            || serverEventTimeEnd === null
            || Date.parse(serverEventTimeEnd) < Date.parse(serverEventTimeStart)))) {
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
        priceBasis: serverPriceBasis,
        priceEpochBasis: serverPriceEpochBasis,
        eventTimeRange: serverEventTimeRange === null
          || serverEventTimeRange === undefined
          ? null
          : { startAt: serverEventTimeStart, endAt: serverEventTimeEnd },
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
const LOCAL_MODELS = new Set([...REVIEWED_CODEX_MODEL_IDS, "unknown"]);
const LOCAL_MODEL_PRICING_STATUSES = new Set([
  "priced",
  "known_unpriced",
  "unrecognized"
]);
const LOCAL_MODEL_ALLOWANCE_TRACKS = new Set(["primary", "spark"]);
const LOCAL_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "unknown"
]);
const CACHE_SWITCH_CHANGE_TYPES = Object.freeze([
  "reasoning_only",
  "model_only",
  "model_and_reasoning"
]);
const CACHE_SWITCH_CHANGE_TYPE_SET = new Set(CACHE_SWITCH_CHANGE_TYPES);
const CACHE_SWITCH_PERIOD_IDS = new Set(["24h", "7d", "30d", "all", "history"]);
const CACHE_SWITCH_RECENT_LIMIT = 20;
const CACHE_SWITCH_PROXIMITY_CEILING_SECONDS = 300;
const CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO = 0.5;
const CACHE_CONTINUITY_MINIMUM_GAP_SECONDS = 0;
const CACHE_CONTINUITY_OUTCOME_DISPLAY_MAXIMUM_GAP_SECONDS = 7 * 24 * 60 * 60;
const CACHE_CONTINUITY_GAP_BANDS = Object.freeze({
  under_one_minute: [0, 60],
  one_to_five_minutes: [60, 300],
  five_to_thirty_minutes: [300, 1_800],
  thirty_minutes_to_one_hour: [1_800, 3_600],
  one_to_six_hours: [3_600, 21_600],
  six_to_twenty_four_hours: [21_600, 86_400],
  over_twenty_four_hours: [86_400, Number.POSITIVE_INFINITY]
});
const CACHE_CONTINUITY_GAP_BAND_IDS = Object.freeze(
  Object.keys(CACHE_CONTINUITY_GAP_BANDS)
);
const CACHE_CONTINUITY_OUTCOME_BUCKETS = Object.freeze({
  under_one_minute: [0, 60],
  one_to_two_minutes: [60, 120],
  two_to_five_minutes: [120, 300],
  five_to_ten_minutes: [300, 600],
  ten_to_thirty_minutes: [600, 1_800],
  thirty_minutes_to_one_hour: [1_800, 3_600],
  one_to_six_hours: [3_600, 21_600],
  six_to_twenty_four_hours: [21_600, 86_400],
  one_to_three_days: [86_400, 259_200],
  over_three_days: [259_200, null]
});
const CACHE_CONTINUITY_OUTCOME_BUCKET_IDS = Object.freeze(
  Object.keys(CACHE_CONTINUITY_OUTCOME_BUCKETS)
);
const CACHE_CONTINUITY_BREAKDOWN_FIELDS = Object.freeze([
  "sameConfigurationReturns",
  "comparableReturns",
  "compactionConfoundedReturns",
  "contextContractedReturns",
  "insufficientEvidenceReturns",
  "uncoveredReturns",
  "reusedMoreThanHalfReturns",
  "reusedHalfOrLessReturns",
  "matchedOrExceededReturns",
  "reusedBetweenHalfAndPreviousReturns",
  "cacheReadDrops",
  "lostCacheTokens",
  "pricedDrops",
  "unpricedDrops"
]);
const SIDE_CHAT_ESTIMATE_SCHEMA_VERSION =
  "development-side-chat-estimate-v0.4";
const SIDE_CHAT_ESTIMATE_PARSER_VERSION =
  "desktop-fork-logs2-active-context-v0.3";
const SIDE_CHAT_HISTORICAL_GAP_SCHEMA_VERSION =
  "development-side-chat-historical-gap-v0.3";
const SIDE_CHAT_RECENT_LIMIT = 500;
const SIDE_CHAT_PERIOD_IDS = new Set(["24h", "7d", "30d", "all"]);
const SIDE_CHAT_CACHE_ASSUMPTIONS = new Set([
  "warm_prefix",
  "cold_after_compaction",
  "retention_unknown"
]);
const SIDE_CHAT_PRICING_BASES = new Set([
  "reviewed_model_card",
  "reviewed_alias_assumption",
  "unavailable"
]);
const SIDE_CHAT_CONDITIONAL_ALIAS_MODELS = new Set([
  "codex-auto-review",
  "gpt-5.5-codex",
  "gpt-5.6-sol-wm"
]);
const SIDE_CHAT_CALIBRATION_STATUSES = new Set([
  "eligible_active_retention",
  "withheld_no_retained_calls",
  "withheld_unpriced_calls",
  "withheld_parser_gaps",
  "withheld_cohort_mismatch",
  "withheld_context_mismatch",
  "withheld_stale_calibration",
  "withheld_unavailable"
]);
const SIDE_CHAT_ASSUMPTIONS = Object.freeze({
  activeToProviderTotal: Object.freeze({
    lowerCost: 1.1137,
    point: 1.0172,
    upperCost: 1.0007
  }),
  outputToInput: Object.freeze({
    lowerCost: 0.00071,
    point: 0.0024,
    upperCost: 0.00953
  }),
  ordinaryCacheReadShare: Object.freeze({
    lowerCost: 0.9954,
    point: 0.9857,
    upperCost: 0
  }),
  postCompactionCacheReadShare: Object.freeze({
    lowerCost: 0,
    point: 0,
    upperCost: 0
  }),
  uncachedRemainderCacheWriteShare: Object.freeze({
    lowerCost: 0,
    point: 0,
    upperCost: 1
  }),
  warmEligibilitySeconds: Object.freeze({
    gpt56: 1800,
    other: 300
  })
});
const CACHE_SWITCH_SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const CACHE_SWITCH_ALLOWANCE_INTERPRETATION =
  "conditional_historical_estimate_not_provider_allowance";
const MONITORING_GAP_COPY = Object.freeze({
  quota_snapshots: ["Quota snapshots", "Current provider quota windows and their freshness."],
  account_attribution: ["Account attribution", "Whether quota and usage can be tied safely to one pseudonymous local account scope."],
  fast_mode: ["Fast-mode accounting", "Codex records the speed mode only when it is applied or changed, never at session start, so turns before the first change in a session carry no recorded tier. An observed tier always wins; a timestamp-covered config declaration comes next, and anything neither covers is attributed to Standard as a visible assumption. Fast increments are priced at the published Priority (Fast) API rate for the model. Window-level inference is diagnostic only and never changes the money."],
  subagents: ["Subagents and child rollouts", "Lineage-aware accounting excludes inherited parent snapshots before attributing genuine child-rollout increments; ambiguous lineage remains unknown."],
  shared_pool_surfaces: ["Work, Workspace Agents, Excel and connected Voice", "These shared-pool surfaces may not write complete local Codex evidence."],
  third_party_auth: ["Third-party ChatGPT-authenticated apps", "No complete local accounting source is available for third-party authenticated apps."],
  reasoning_effort: ["Reasoning effort", "The unified index can identify known reasoning changes for the switch diagnostic, but ordinary usage accounting does not yet provide a complete per-request reasoning-effort breakdown."],
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
      costUsd: nonNegative(row.costUsd, 0)
    }];
  }));
}

/**
 * A model row's own token split, or `null` when the row carried none.
 *
 * Absence and zero are different claims here. A projection that never
 * accumulated components must not be normalised into six zeroes, because the
 * renderer would then draw a complete breakdown asserting the model read no
 * tokens of any kind. `null` keeps "this row cannot say" separate from "this
 * row says none", exactly as the model table already does for a price it does
 * not have.
 */
function normalizeLocalModelComponents(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const present = LOCAL_COMPONENT_KEYS.some((key) => (
    Number.isSafeInteger(value[key]) && value[key] >= 0
  ));
  return present ? normalizeLocalComponents(value) : null;
}

/** The same rule for the per-component priced amounts. */
function normalizeLocalModelComponentCosts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const present = LOCAL_COMPONENT_KEYS.some((key) => (
    value[key] !== null && typeof value[key] === "object"
  ));
  return present ? normalizeLocalComponentCosts(value) : null;
}

function unavailableAllowanceImpact(reason = null) {
  return {
    status: "unavailable",
    reason: typeof reason === "string" && CACHE_SWITCH_SAFE_CODE.test(reason)
      ? reason
      : null,
    basisFamilyId: null,
    selectedScenario: null,
    medianPercentagePoints: null,
    percentagePointRange: null,
    plausibleRangePercentagePoints: null,
    scenarios: {
      unresolved_as_standard: null,
      unresolved_as_fast: null
    },
    interpretation: CACHE_SWITCH_ALLOWANCE_INTERPRETATION
  };
}

function normalizeCacheAllowanceScenario(value, scenario) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.basisId !== allowanceBasisId(scenario)) return null;
  const premium = nonNegative(value.quotaWeightedPremiumUsd, null);
  const capacity = nonNegative(value.medianCapacityUsd, null);
  const median = nonNegative(value.medianPercentagePoints, null);
  const lower = nonNegative(value?.plausibleRangePercentagePoints?.lower, null);
  const upper = nonNegative(value?.plausibleRangePercentagePoints?.upper, null);
  if (premium === null || capacity === null || capacity <= 0 || median === null
      || lower === null || upper === null || lower > median || median > upper
      || Math.abs(median - (100 * premium) / capacity) > 0.000002) return null;
  return {
    basisId: allowanceBasisId(scenario),
    quotaWeightedPremiumUsd: premium,
    medianCapacityUsd: capacity,
    medianPercentagePoints: median,
    plausibleRangePercentagePoints: { lower, upper }
  };
}

function normalizeCacheSwitchAllowanceImpact(value) {
  if (value?.status === "unavailable") {
    return unavailableAllowanceImpact(value?.reason);
  }
  if (!new Set(["complete", "range"]).has(value?.status)
      || value?.basisFamilyId !== ALLOWANCE_BASIS_FAMILY_ID
      || value?.interpretation !== CACHE_SWITCH_ALLOWANCE_INTERPRETATION
      || value?.reason !== null) return unavailableAllowanceImpact();
  const scenarios = Object.fromEntries(ALLOWANCE_SCENARIOS.map((scenario) => [
    scenario,
    value.scenarios?.[scenario] === null
      ? null
      : normalizeCacheAllowanceScenario(value.scenarios?.[scenario], scenario)
  ]));
  const selectedScenario = ALLOWANCE_SCENARIOS.includes(value.selectedScenario)
    ? value.selectedScenario
    : null;
  const median = value.medianPercentagePoints === null
    ? null
    : nonNegative(value.medianPercentagePoints, null);
  const plausibleLower = nonNegative(
    value?.plausibleRangePercentagePoints?.lower,
    null
  );
  const plausibleUpper = nonNegative(
    value?.plausibleRangePercentagePoints?.upper,
    null
  );
  if (plausibleLower === null || plausibleUpper === null
      || plausibleLower > plausibleUpper) return unavailableAllowanceImpact();
  if (value.status === "complete") {
    const selected = scenarios[selectedScenario];
    if (selectedScenario === null || selected === null || median === null
        || Math.abs(selected.medianPercentagePoints - median) > 0.000002
        || value.percentagePointRange !== null) {
      return unavailableAllowanceImpact();
    }
    return {
      status: "complete",
      reason: null,
      basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
      selectedScenario,
      medianPercentagePoints: median,
      percentagePointRange: null,
      plausibleRangePercentagePoints: {
        lower: plausibleLower,
        upper: plausibleUpper
      },
      scenarios,
      interpretation: CACHE_SWITCH_ALLOWANCE_INTERPRETATION
    };
  }
  const rangeLower = nonNegative(value?.percentagePointRange?.lower, null);
  const rangeUpper = nonNegative(value?.percentagePointRange?.upper, null);
  if (selectedScenario !== null || median !== null
      || Object.values(scenarios).includes(null)
      || rangeLower === null || rangeUpper === null || rangeLower > rangeUpper) {
    return unavailableAllowanceImpact();
  }
  const medians = ALLOWANCE_SCENARIOS.map(
    (scenario) => scenarios[scenario].medianPercentagePoints
  );
  if (Math.abs(rangeLower - Math.min(...medians)) > 0.000002
      || Math.abs(rangeUpper - Math.max(...medians)) > 0.000002) {
    return unavailableAllowanceImpact();
  }
  return {
    status: "range",
    reason: null,
    basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
    selectedScenario: null,
    medianPercentagePoints: null,
    percentagePointRange: { lower: rangeLower, upper: rangeUpper },
    plausibleRangePercentagePoints: {
      lower: plausibleLower,
      upper: plausibleUpper
    },
    scenarios,
    interpretation: CACHE_SWITCH_ALLOWANCE_INTERPRETATION
  };
}

function normalizeCachePremiumScenario(value, scenario, pricedDrops) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.basisId !== allowanceBasisId(scenario)
      || value.basisFamilyId !== ALLOWANCE_BASIS_FAMILY_ID) return null;
  const premium = nonNegative(value.quotaWeightedPremiumUsd, null);
  const fields = [
    "pricedDrops",
    "observedSpeedDrops",
    "declaredSpeedDrops",
    "assumedSpeedDrops",
    "unknownSpeedDrops"
  ];
  const counts = Object.fromEntries(fields.map((field) => [
    field,
    count(value[field], null)
  ]));
  if (premium === null || Object.values(counts).includes(null)
      || counts.pricedDrops !== pricedDrops
      || counts.observedSpeedDrops + counts.declaredSpeedDrops
        + counts.assumedSpeedDrops + counts.unknownSpeedDrops !== pricedDrops) {
    return null;
  }
  return {
    basisId: allowanceBasisId(scenario),
    quotaWeightedPremiumUsd: premium,
    ...counts
  };
}

function normalizeCachePremiumWeighting(value, pricedDrops, standardPremium) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !["complete", "range", "unavailable"].includes(value.status)
      || value.basisFamilyId !== ALLOWANCE_BASIS_FAMILY_ID) return null;
  const scenarios = Object.fromEntries(ALLOWANCE_SCENARIOS.map((scenario) => [
    scenario,
    value.scenarios?.[scenario] === null
      ? null
      : normalizeCachePremiumScenario(
        value.scenarios?.[scenario],
        scenario,
        pricedDrops
      )
  ]));
  const selectedScenario = ALLOWANCE_SCENARIOS.includes(value.selectedScenario)
    ? value.selectedScenario
    : null;
  const selectedPremiumUsd = nonNegative(value.selectedPremiumUsd, null);
  if (value.status === "complete") {
    const selected = scenarios[selectedScenario];
    if (selectedScenario === null || selected === null
        || selectedPremiumUsd === null
        || Math.abs(selectedPremiumUsd - selected.quotaWeightedPremiumUsd)
          > 0.000002
        || value.rangePremiumUsd !== null) return null;
  } else if (value.status === "range") {
    const lower = nonNegative(value?.rangePremiumUsd?.lower, null);
    const upper = nonNegative(value?.rangePremiumUsd?.upper, null);
    const premiums = ALLOWANCE_SCENARIOS.map(
      (scenario) => scenarios[scenario]?.quotaWeightedPremiumUsd ?? null
    );
    if (selectedScenario !== null || selectedPremiumUsd !== null
        || premiums.includes(null) || lower === null || upper === null
        || Math.abs(lower - Math.min(...premiums)) > 0.000002
        || Math.abs(upper - Math.max(...premiums)) > 0.000002) return null;
  } else if (selectedScenario !== null || selectedPremiumUsd !== null
      || value.rangePremiumUsd !== null
      || typeof value.reasonCode !== "string"
      || !CACHE_SWITCH_SAFE_CODE.test(value.reasonCode)) return null;
  if (standardPremium !== null) {
    for (const scenario of ALLOWANCE_SCENARIOS) {
      const premium = scenarios[scenario]?.quotaWeightedPremiumUsd;
      if (premium !== null && premium !== undefined
          && (premium + 0.000002 < standardPremium
            || premium > standardPremium * 2.5 + 0.000002)) return null;
    }
  }
  return {
    status: value.status,
    reasonCode: value.status === "unavailable" ? value.reasonCode : null,
    basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
    selectedScenario,
    selectedPremiumUsd,
    scenarios,
    rangePremiumUsd: value.status === "range"
      ? {
        lower: value.rangePremiumUsd.lower,
        upper: value.rangePremiumUsd.upper
      }
      : null
  };
}

function normalizeCacheCoveredSubtotal(value, pricedDrops, completePremium) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.scope !== "covered_priced_drops"
      || !Number.isSafeInteger(pricedDrops) || pricedDrops <= 0
      || value.pricedDrops !== pricedDrops
      || typeof value.standardApiPremiumUsd !== "number"
      || !Number.isFinite(value.standardApiPremiumUsd)
      || value.standardApiPremiumUsd < 0
      || typeof value.standardApiPremiumUsdExact !== "string"
      || value.standardApiPremiumUsdExact.length > 64
      || !/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/u.test(value.standardApiPremiumUsdExact)
      || Number(value.standardApiPremiumUsdExact) !== value.standardApiPremiumUsd
      || (completePremium !== null
        && Math.abs(completePremium - value.standardApiPremiumUsd) > 1e-9)) return null;
  const allowanceWeighting = normalizeCachePremiumWeighting(
    value.allowanceWeighting, pricedDrops, value.standardApiPremiumUsd
  );
  if (allowanceWeighting === null) return null;
  return {
    scope: "covered_priced_drops",
    pricedDrops,
    standardApiPremiumUsd: value.standardApiPremiumUsd,
    standardApiPremiumUsdExact: value.standardApiPremiumUsdExact,
    allowanceWeighting
  };
}

function cacheCoveredSubtotalsMatch(total, rows) {
  if (total.coveredSubtotal === null) return true;
  if (rows.some((row) => row.pricedDrops > 0 && row.coveredSubtotal === null)) return false;
  // These strings have already passed the closed, nine-decimal validator.
  // Compare exact sums, including for amounts that exceed float precision.
  const nanos = (subtotal) => {
    const [whole, fraction = ""] = subtotal.standardApiPremiumUsdExact.split(".");
    return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
  };
  const sum = rows.reduce((amount, row) => amount + (
    row.coveredSubtotal === null ? 0n : nanos(row.coveredSubtotal)
  ), 0n);
  return sum === nanos(total.coveredSubtotal);
}

function normalizeCacheSwitchBreakdown(value, includeOrderingCoverage = false) {
  const configurationChanges = count(value?.configurationChanges, null);
  const proximateConfigurationChanges = count(
    value?.proximateConfigurationChanges,
    null
  );
  const cacheReadDrops = count(value?.cacheReadDrops, null);
  const uncoveredConfigurationChanges = count(
    value?.uncoveredConfigurationChanges,
    null
  );
  const orderingCoverageGaps = includeOrderingCoverage
    ? count(value?.orderingCoverageGaps, 0)
    : 0;
  const coverageStatus = value?.coverageStatus;
  const lostCacheTokens = count(value?.lostCacheTokens, null);
  const pricedDrops = count(value?.pricedDrops, null);
  const unpricedDrops = count(value?.unpricedDrops, null);
  const premium = value?.estimatedPremiumUsd === null
    ? null
    : nonNegative(value?.estimatedPremiumUsd, null);
  if (configurationChanges === null
      || proximateConfigurationChanges === null
      || cacheReadDrops === null
      || uncoveredConfigurationChanges === null
      || orderingCoverageGaps === null
      || lostCacheTokens === null
      || pricedDrops === null
      || unpricedDrops === null
      || proximateConfigurationChanges > configurationChanges
      || uncoveredConfigurationChanges > configurationChanges
      || !new Set(["complete", "incomplete"]).has(coverageStatus)
      || (coverageStatus === "complete"
        && uncoveredConfigurationChanges + orderingCoverageGaps !== 0)
      || (coverageStatus === "incomplete"
        && uncoveredConfigurationChanges + orderingCoverageGaps === 0)
      || cacheReadDrops > proximateConfigurationChanges
      || pricedDrops + unpricedDrops !== cacheReadDrops
      || (cacheReadDrops === 0 && lostCacheTokens !== 0)
      || (cacheReadDrops > 0 && lostCacheTokens === 0)
      || (cacheReadDrops === 0 && premium !== 0 && premium !== null)
      // Unpriced drops withhold the full-period amount. Any covered/priced
      // subtotal has its own explicit scope and cannot replace this field.
      || ((unpricedDrops > 0 || coverageStatus === "incomplete")
        && premium !== null)
      || (unpricedDrops === 0 && coverageStatus === "complete"
        && premium === null)) {
    return null;
  }
  const coveredSubtotal = normalizeCacheCoveredSubtotal(
    value?.coveredSubtotal, pricedDrops, premium
  );
  if (value?.coveredSubtotal != null && coveredSubtotal === null) return null;
  return {
    configurationChanges,
    proximateConfigurationChanges,
    uncoveredConfigurationChanges,
    ...(includeOrderingCoverage ? { orderingCoverageGaps } : {}),
    coverageStatus,
    cacheReadDrops,
    lostCacheTokens,
    estimatedPremiumUsd: premium,
    coveredSubtotal,
    pricedDrops,
    unpricedDrops
  };
}

function normalizeCacheSwitchState(value) {
  const model = LOCAL_MODELS.has(value?.model) ? value.model : "unknown";
  const reasoningEffort = LOCAL_REASONING_EFFORTS.has(value?.reasoningEffort)
    ? value.reasoningEffort
    : "unknown";
  return { model, reasoningEffort };
}

// This separate contract is only for interactive local navigation. Never add
// its names or raw thread identifiers to normalized accounting/report DTOs.
const LOCAL_CACHE_DROP_THREAD_LINKS_SCHEMA = "local-cache-drop-thread-links-v1";
const CACHE_DROP_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_CACHE_DROP_THREAD_LINKS = 160;

function normalizeAccountingGeneration(value) {
  if (typeof value !== "number"
      && (typeof value !== "string" || value.length > 32
        || !/^[1-9]\d*(?:\.0+)?$/u.test(value))) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : null;
}

/** Mirrors the companion's content-free event-pair key, never an identity. */
export function cacheDropThreadLookupKey(kind, row) {
  if (!["switch", "continuity"].includes(kind)
      || !row || typeof row !== "object" || Array.isArray(row)) return null;
  const previous = kind === "switch" ? row.previous : row.configuration;
  const current = kind === "switch" ? row.current : row.configuration;
  for (const configuration of [previous, current]) {
    if (!configuration || typeof configuration.model !== "string"
        || configuration.model.length > 200
        || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(configuration.model)
        || configuration.reasoningEffort === "unknown"
        || !LOCAL_REASONING_EFFORTS.has(configuration.reasoningEffort)) return null;
  }
  if (typeof row.observedAt !== "string" || row.observedAt.length !== 24
      || canonicalInstant(row.observedAt) === null
      || typeof row.gapSeconds !== "number" || !Number.isFinite(row.gapSeconds)
      || row.gapSeconds < 0
      || ![row.previousCacheReadTokens, row.currentCacheReadTokens, row.lostCacheTokens]
        .every((value) => Number.isSafeInteger(value) && value >= 0)
      || row.lostCacheTokens < 1
      || row.currentCacheReadTokens > row.previousCacheReadTokens / 2
      || row.lostCacheTokens > row.previousCacheReadTokens - row.currentCacheReadTokens) return null;
  const observedMs = Date.parse(row.observedAt);
  const gapMs = Math.round(row.gapSeconds * 1_000);
  if (!Number.isSafeInteger(gapMs) || gapMs < 0
      || gapMs / 1_000 !== row.gapSeconds || observedMs < gapMs) return null;
  return JSON.stringify([
    kind, row.observedAt, row.gapSeconds,
    previous.model, previous.reasoningEffort,
    current.model, current.reasoningEffort,
    row.previousCacheReadTokens, row.currentCacheReadTokens, row.lostCacheTokens
  ]);
}

function validCacheDropThreadKey(kind, key) {
  if (typeof key !== "string" || key.length > 2048) return false;
  let tuple;
  try { tuple = JSON.parse(key); } catch { return false; }
  if (!Array.isArray(tuple) || tuple.length !== 10 || tuple[0] !== kind) return false;
  const previous = { model: tuple[3], reasoningEffort: tuple[4] };
  const current = { model: tuple[5], reasoningEffort: tuple[6] };
  return cacheDropThreadLookupKey(kind, {
    observedAt: tuple[1], gapSeconds: tuple[2], previous, current,
    configuration: current,
    previousCacheReadTokens: tuple[7], currentCacheReadTokens: tuple[8],
    lostCacheTokens: tuple[9]
  }) === key;
}

function validLocalThreadName(value, maximum = 512) {
  return value === null || (typeof value === "string"
    && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
}

export function normalizeCacheDropThreadLinks(value) {
  const unavailable = {
    schemaVersion: LOCAL_CACHE_DROP_THREAD_LINKS_SCHEMA,
    status: "unavailable", generation: null, entries: []
  };
  if (!hasExactKeys(value, ["schemaVersion", "status", "generation", "entries"])
      || value.schemaVersion !== LOCAL_CACHE_DROP_THREAD_LINKS_SCHEMA
      || value.status !== "available"
      || !Array.isArray(value.entries)
      || value.entries.length > MAX_CACHE_DROP_THREAD_LINKS) return unavailable;
  const generation = normalizeAccountingGeneration(value.generation);
  if (generation === null) return unavailable;
  const seen = new Set();
  const entries = [];
  for (const entry of value.entries) {
    const thread = entry?.thread;
    if (!hasExactKeys(entry, ["kind", "key", "thread"])
        || !validCacheDropThreadKey(entry.kind, entry.key)
        || seen.has(entry.key)
        || !hasExactKeys(thread, ["id", "name", "nickname", "parent"])
        || typeof thread.id !== "string" || !CACHE_DROP_THREAD_ID.test(thread.id)
        || !validLocalThreadName(thread.name)
        || !validLocalThreadName(thread.nickname, 80)) return unavailable;
    const parent = thread.parent;
    if (parent !== null && (!hasExactKeys(parent, ["id", "name"])
        || typeof parent.id !== "string" || !CACHE_DROP_THREAD_ID.test(parent.id)
        || parent.id === thread.id || !validLocalThreadName(parent.name))) return unavailable;
    seen.add(entry.key);
    entries.push({
      kind: entry.kind,
      key: entry.key,
      thread: {
        id: thread.id, name: thread.name, nickname: thread.nickname,
        parent: parent === null ? null : { id: parent.id, name: parent.name }
      }
    });
  }
  return { schemaVersion: LOCAL_CACHE_DROP_THREAD_LINKS_SCHEMA, status: "available", generation, entries };
}

function normalizeCacheSwitchRecent(rows, maximumRows) {
  return array(rows)
    // Bound work before parsing and sorting as well as bounding the output.
    .slice(0, CACHE_SWITCH_RECENT_LIMIT * 2)
    .flatMap((row) => {
      const observedAt = canonicalInstant(row?.observedAt);
      const changeType = CACHE_SWITCH_CHANGE_TYPE_SET.has(row?.changeType)
        ? row.changeType
        : null;
      const previous = normalizeCacheSwitchState(row?.previous);
      const current = normalizeCacheSwitchState(row?.current);
      const previousCacheReadTokens = count(row?.previousCacheReadTokens, null);
      const currentCacheReadTokens = count(row?.currentCacheReadTokens, null);
      const lostCacheTokens = count(row?.lostCacheTokens, null);
      const gapSeconds = nonNegative(row?.gapSeconds, null);
      const premium = row?.estimatedPremiumUsd === null
        ? null
        : nonNegative(row?.estimatedPremiumUsd, null);
      const modelChanged = previous.model !== "unknown"
        && current.model !== "unknown"
        && previous.model !== current.model;
      const reasoningChanged = previous.reasoningEffort !== "unknown"
        && current.reasoningEffort !== "unknown"
        && codexCacheReasoningConfiguration(previous.model, previous.reasoningEffort)
          !== codexCacheReasoningConfiguration(current.model, current.reasoningEffort);
      const changeMatches = changeType === "model_only"
        ? modelChanged && !reasoningChanged
        : changeType === "reasoning_only"
          ? !modelChanged && reasoningChanged
          : modelChanged && reasoningChanged;
      if (observedAt === null
          || previous.model === "unknown" || current.model === "unknown"
          || !changeMatches
          || previousCacheReadTokens === null
          || currentCacheReadTokens === null
          || lostCacheTokens === null
          || gapSeconds === null
          || gapSeconds > CACHE_SWITCH_PROXIMITY_CEILING_SECONDS
          || previousCacheReadTokens <= currentCacheReadTokens
          || currentCacheReadTokens
            > previousCacheReadTokens * CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO
          || lostCacheTokens <= 0
          || lostCacheTokens > previousCacheReadTokens - currentCacheReadTokens) {
        return [];
      }
      // This explicit projection is also the browser privacy boundary. Any
      // session, event, path, or rollout fields on a hostile row are dropped.
      return [{
        observedAt,
        gapSeconds,
        changeType,
        previous,
        current,
        previousCacheReadTokens,
        currentCacheReadTokens,
        lostCacheTokens,
        estimatedPremiumUsd: premium
      }];
    })
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
    .slice(0, Math.min(CACHE_SWITCH_RECENT_LIMIT, maximumRows));
}

function normalizeCacheSwitchSummary(value) {
  const totals = normalizeCacheSwitchBreakdown(value, true);
  if (totals === null) return null;
  const allowanceWeighting = normalizeCachePremiumWeighting(
    value?.allowanceWeighting,
    totals.pricedDrops,
    totals.estimatedPremiumUsd
  );
  if (allowanceWeighting === null
      || (totals.estimatedPremiumUsd === null
        && allowanceWeighting.status !== "unavailable")) return null;
  const breakdownRows = CACHE_SWITCH_CHANGE_TYPES.map((key) => (
    [key, normalizeCacheSwitchBreakdown(value?.byChangeType?.[key])]
  ));
  if (breakdownRows.some(([, row]) => row === null)) return null;
  const byChangeType = Object.fromEntries(breakdownRows);
  if (!cacheCoveredSubtotalsMatch(totals, Object.values(byChangeType))) return null;
  for (const field of [
    "configurationChanges",
    "proximateConfigurationChanges",
    "uncoveredConfigurationChanges",
    "cacheReadDrops",
    "lostCacheTokens",
    "pricedDrops",
    "unpricedDrops"
  ]) {
    if (CACHE_SWITCH_CHANGE_TYPES.reduce(
      (sum, key) => sum + byChangeType[key][field],
      0
    ) !== totals[field]) return null;
  }
  if (totals.estimatedPremiumUsd !== null) {
    const premiumSum = CACHE_SWITCH_CHANGE_TYPES.reduce(
      (sum, key) => sum + byChangeType[key].estimatedPremiumUsd,
      0
    );
    if (Math.abs(premiumSum - totals.estimatedPremiumUsd) > 1e-9) return null;
  }
  return {
    ...totals,
    standardApiPremiumUsd: totals.estimatedPremiumUsd,
    allowanceWeighting,
    byChangeType,
    recent: normalizeCacheSwitchRecent(value?.recent, totals.cacheReadDrops),
    allowanceImpact: totals.estimatedPremiumUsd === null
      ? unavailableAllowanceImpact("weighting_evidence_incomplete")
      : normalizeCacheSwitchAllowanceImpact(value?.allowanceImpact)
  };
}

function unavailableCacheSwitchImpact(errorCode = null) {
  return {
    status: "unavailable",
    errorCode: typeof errorCode === "string" && CACHE_SWITCH_SAFE_CODE.test(errorCode)
      ? errorCode
      : null,
    periodId: null,
    periodLabel: "",
    configurationChanges: 0,
    proximateConfigurationChanges: 0,
    uncoveredConfigurationChanges: 0,
    orderingCoverageGaps: 0,
    coverageStatus: "incomplete",
    cacheReadDrops: 0,
    lostCacheTokens: 0,
    estimatedPremiumUsd: null,
    standardApiPremiumUsd: null,
    allowanceWeighting: null,
    coveredSubtotal: null,
    pricedDrops: 0,
    unpricedDrops: 0,
    byChangeType: Object.fromEntries(CACHE_SWITCH_CHANGE_TYPES.map((key) => [key, {
      configurationChanges: 0,
      proximateConfigurationChanges: 0,
      uncoveredConfigurationChanges: 0,
      coverageStatus: "incomplete",
      cacheReadDrops: 0,
      lostCacheTokens: 0,
      estimatedPremiumUsd: null,
      pricedDrops: 0,
      unpricedDrops: 0
    }])),
    recent: [],
    allowanceImpact: unavailableAllowanceImpact(),
    proximityCeilingSeconds: CACHE_SWITCH_PROXIMITY_CEILING_SECONDS,
    maximumRetainedCacheRatio: CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO,
    recentDetailLimit: CACHE_SWITCH_RECENT_LIMIT,
    periods: []
  };
}

function normalizeCacheSwitchImpact(value) {
  if (value?.status !== "available") {
    return unavailableCacheSwitchImpact(value?.errorCode);
  }
  if (finite(value.maximumRetainedCacheRatio, null)
      !== CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO
      || finite(value.proximityCeilingSeconds, null)
        !== CACHE_SWITCH_PROXIMITY_CEILING_SECONDS
      || count(value.recentDetailLimit, null) !== CACHE_SWITCH_RECENT_LIMIT) {
    return unavailableCacheSwitchImpact("methodology_mismatch");
  }
  const periods = array(value.periods)
    .slice(0, 5)
    .flatMap((period) => {
      if (!CACHE_SWITCH_PERIOD_IDS.has(period?.periodId)) return [];
      const summary = normalizeCacheSwitchSummary(period);
      return summary === null ? [] : [{
        status: "available",
        errorCode: null,
        periodId: period.periodId,
        periodLabel: text(period.periodLabel, "Recorded period"),
        ...summary,
        allowanceImpact: period.periodId === "7d"
          ? summary.allowanceImpact
          : unavailableAllowanceImpact("period_denominator_mismatch"),
        proximityCeilingSeconds: CACHE_SWITCH_PROXIMITY_CEILING_SECONDS,
        maximumRetainedCacheRatio: CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO,
        recentDetailLimit: CACHE_SWITCH_RECENT_LIMIT,
        periods: []
      }];
    });
  const selected = normalizeCacheSwitchSummary(value);
  const periodId = CACHE_SWITCH_PERIOD_IDS.has(value?.periodId)
    ? value.periodId
    : null;
  if (selected === null || periodId === null) {
    return { ...unavailableCacheSwitchImpact(), periods };
  }
  return {
    status: "available",
    errorCode: null,
    periodId,
    periodLabel: text(value.periodLabel, "Recorded period"),
    ...selected,
    allowanceImpact: periodId === "7d"
      ? selected.allowanceImpact
      : unavailableAllowanceImpact("period_denominator_mismatch"),
    proximityCeilingSeconds: CACHE_SWITCH_PROXIMITY_CEILING_SECONDS,
    maximumRetainedCacheRatio: CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO,
    recentDetailLimit: CACHE_SWITCH_RECENT_LIMIT,
    periods
  };
}

function normalizeCacheContinuityBreakdown(value, includeOrderingCoverage = false) {
  const normalized = Object.fromEntries(
    CACHE_CONTINUITY_BREAKDOWN_FIELDS.map((field) => [
      field,
      count(value?.[field], null)
    ])
  );
  if (CACHE_CONTINUITY_BREAKDOWN_FIELDS.some(
    (field) => normalized[field] === null
  )) return null;
  const orderingCoverageGaps = includeOrderingCoverage
    ? count(value?.orderingCoverageGaps, 0)
    : 0;
  if (orderingCoverageGaps === null) return null;
  const coverageStatus = value?.coverageStatus;
  const premium = value?.estimatedPremiumUsd === null
    ? null
    : nonNegative(value?.estimatedPremiumUsd, null);
  const partition = normalized.comparableReturns
    + normalized.compactionConfoundedReturns
    + normalized.contextContractedReturns
    + normalized.insufficientEvidenceReturns
    + normalized.uncoveredReturns;
  if (!new Set(["complete", "incomplete"]).has(coverageStatus)
      || partition !== normalized.sameConfigurationReturns
      || normalized.cacheReadDrops > normalized.comparableReturns
      || normalized.reusedMoreThanHalfReturns
        + normalized.reusedHalfOrLessReturns !== normalized.comparableReturns
      || normalized.matchedOrExceededReturns
        + normalized.reusedBetweenHalfAndPreviousReturns
          !== normalized.reusedMoreThanHalfReturns
      || normalized.cacheReadDrops !== normalized.reusedHalfOrLessReturns
      || normalized.pricedDrops + normalized.unpricedDrops
        !== normalized.cacheReadDrops
      || (normalized.cacheReadDrops === 0 && normalized.lostCacheTokens !== 0)
      || (normalized.cacheReadDrops > 0 && normalized.lostCacheTokens === 0)
      || (coverageStatus === "complete"
        && normalized.uncoveredReturns + orderingCoverageGaps !== 0)
      || (coverageStatus === "incomplete"
        && normalized.uncoveredReturns + orderingCoverageGaps === 0)
      || (normalized.cacheReadDrops === 0 && premium !== 0 && premium !== null)
      || ((normalized.unpricedDrops > 0 || coverageStatus === "incomplete")
        && premium !== null)
      || (normalized.unpricedDrops === 0 && coverageStatus === "complete"
        && premium === null)) {
    return null;
  }
  const coveredSubtotal = normalizeCacheCoveredSubtotal(
    value?.coveredSubtotal, normalized.pricedDrops, premium
  );
  if (value?.coveredSubtotal != null && coveredSubtotal === null) return null;
  return {
    ...normalized,
    ...(includeOrderingCoverage ? { orderingCoverageGaps } : {}),
    coverageStatus,
    estimatedPremiumUsd: premium,
    coveredSubtotal
  };
}

function normalizeCacheContinuityRecent(rows, maximumRows) {
  return array(rows)
    .slice(0, CACHE_SWITCH_RECENT_LIMIT * 2)
    .flatMap((row) => {
      const observedAt = canonicalInstant(row?.observedAt);
      const gapSeconds = nonNegative(row?.gapSeconds, null);
      const gapBand = Object.hasOwn(CACHE_CONTINUITY_GAP_BANDS, row?.gapBand)
        ? row.gapBand
        : null;
      const configuration = normalizeCacheSwitchState(row?.configuration);
      const previousCacheReadTokens = count(row?.previousCacheReadTokens, null);
      const currentCacheReadTokens = count(row?.currentCacheReadTokens, null);
      const lostCacheTokens = count(row?.lostCacheTokens, null);
      const premium = row?.estimatedPremiumUsd === null
        ? null
        : nonNegative(row?.estimatedPremiumUsd, null);
      const bounds = gapBand === null ? null : CACHE_CONTINUITY_GAP_BANDS[gapBand];
      if (observedAt === null
          || gapSeconds === null
          || bounds === null
          || gapSeconds < bounds[0]
          || gapSeconds >= bounds[1]
          || configuration.model === "unknown"
          || configuration.reasoningEffort === "unknown"
          || previousCacheReadTokens === null
          || currentCacheReadTokens === null
          || lostCacheTokens === null
          || previousCacheReadTokens <= currentCacheReadTokens
          || currentCacheReadTokens
            > previousCacheReadTokens * CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO
          || lostCacheTokens <= 0
          || lostCacheTokens > previousCacheReadTokens - currentCacheReadTokens) {
        return [];
      }
      return [{
        observedAt,
        gapSeconds,
        gapBand,
        configuration,
        previousCacheReadTokens,
        currentCacheReadTokens,
        lostCacheTokens,
        estimatedPremiumUsd: premium
      }];
    })
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
    .slice(0, Math.min(CACHE_SWITCH_RECENT_LIMIT, maximumRows));
}

function normalizeCacheContinuitySummary(value) {
  const totals = normalizeCacheContinuityBreakdown(value, true);
  if (totals === null) return null;
  const allowanceWeighting = normalizeCachePremiumWeighting(
    value?.allowanceWeighting,
    totals.pricedDrops,
    totals.estimatedPremiumUsd
  );
  if (allowanceWeighting === null
      || (totals.estimatedPremiumUsd === null
        && allowanceWeighting.status !== "unavailable")) return null;
  const byGapBandRows = CACHE_CONTINUITY_GAP_BAND_IDS.map((key) => [
    key,
    normalizeCacheContinuityBreakdown(value?.byGapBand?.[key])
  ]);
  if (byGapBandRows.some(([, row]) => row === null)) return null;
  const byGapBand = Object.fromEntries(byGapBandRows);
  if (!cacheCoveredSubtotalsMatch(totals, Object.values(byGapBand))) return null;
  for (const field of CACHE_CONTINUITY_BREAKDOWN_FIELDS) {
    if (CACHE_CONTINUITY_GAP_BAND_IDS.reduce(
      (sum, key) => sum + byGapBand[key][field],
      0
    ) !== totals[field]) return null;
  }
  if (totals.estimatedPremiumUsd !== null) {
    const premiumSum = CACHE_CONTINUITY_GAP_BAND_IDS.reduce(
      (sum, key) => sum + byGapBand[key].estimatedPremiumUsd,
      0
    );
    if (Math.abs(premiumSum - totals.estimatedPremiumUsd) > 1e-9) return null;
  }
  const byOutcomeBucketRows = CACHE_CONTINUITY_OUTCOME_BUCKET_IDS.map((key) => {
    const bounds = CACHE_CONTINUITY_OUTCOME_BUCKETS[key];
    const valueBucket = value?.byOutcomeBucket?.[key];
    const summary = normalizeCacheContinuityBreakdown(valueBucket);
    const startSeconds = finite(valueBucket?.startSeconds, null);
    const endSeconds = valueBucket?.endSeconds === null
      ? null
      : finite(valueBucket?.endSeconds, null);
    if (summary === null
        || startSeconds !== bounds[0]
        || endSeconds !== bounds[1]) return [key, null];
    return [key, { startSeconds, endSeconds, ...summary }];
  });
  if (byOutcomeBucketRows.some(([, row]) => row === null)) return null;
  const byOutcomeBucket = Object.fromEntries(byOutcomeBucketRows);
  if (!cacheCoveredSubtotalsMatch(totals, Object.values(byOutcomeBucket))) return null;
  for (const field of CACHE_CONTINUITY_BREAKDOWN_FIELDS) {
    if (CACHE_CONTINUITY_OUTCOME_BUCKET_IDS.reduce(
      (sum, key) => sum + byOutcomeBucket[key][field],
      0
    ) !== totals[field]) return null;
  }
  if (totals.estimatedPremiumUsd !== null) {
    const premiumSum = CACHE_CONTINUITY_OUTCOME_BUCKET_IDS.reduce(
      (sum, key) => sum + byOutcomeBucket[key].estimatedPremiumUsd,
      0
    );
    if (Math.abs(premiumSum - totals.estimatedPremiumUsd) > 1e-9) return null;
  }
  const postCompactionRequests = count(value?.postCompactionRequests, null);
  const postCompactionCacheReadDrops = count(
    value?.postCompactionCacheReadDrops,
    null
  );
  if (postCompactionRequests === null
      || postCompactionCacheReadDrops === null
      || postCompactionCacheReadDrops > postCompactionRequests) return null;
  return {
    ...totals,
    standardApiPremiumUsd: totals.estimatedPremiumUsd,
    allowanceWeighting,
    postCompactionRequests,
    postCompactionCacheReadDrops,
    byGapBand,
    byOutcomeBucket,
    recent: normalizeCacheContinuityRecent(value?.recent, totals.cacheReadDrops),
    allowanceImpact: totals.estimatedPremiumUsd === null
      ? unavailableAllowanceImpact("weighting_evidence_incomplete")
      : normalizeCacheSwitchAllowanceImpact(value?.allowanceImpact)
  };
}

function unavailableCacheContinuityImpact(errorCode = null) {
  return {
    status: "unavailable",
    errorCode: typeof errorCode === "string" && CACHE_SWITCH_SAFE_CODE.test(errorCode)
      ? errorCode
      : null,
    periodId: null,
    periodLabel: "",
    sameConfigurationReturns: 0,
    comparableReturns: 0,
    compactionConfoundedReturns: 0,
    contextContractedReturns: 0,
    insufficientEvidenceReturns: 0,
    uncoveredReturns: 0,
    reusedMoreThanHalfReturns: 0,
    reusedHalfOrLessReturns: 0,
    matchedOrExceededReturns: 0,
    reusedBetweenHalfAndPreviousReturns: 0,
    orderingCoverageGaps: 0,
    coverageStatus: "incomplete",
    cacheReadDrops: 0,
    lostCacheTokens: 0,
    estimatedPremiumUsd: null,
    standardApiPremiumUsd: null,
    allowanceWeighting: null,
    coveredSubtotal: null,
    pricedDrops: 0,
    unpricedDrops: 0,
    postCompactionRequests: 0,
    postCompactionCacheReadDrops: 0,
    byGapBand: {},
    byOutcomeBucket: {},
    recent: [],
    allowanceImpact: unavailableAllowanceImpact(),
    minimumGapSeconds: CACHE_CONTINUITY_MINIMUM_GAP_SECONDS,
    maximumRetainedCacheRatio: CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO,
    outcomeDisplayMaximumGapSeconds:
      CACHE_CONTINUITY_OUTCOME_DISPLAY_MAXIMUM_GAP_SECONDS,
    recentDetailLimit: CACHE_SWITCH_RECENT_LIMIT,
    periods: []
  };
}

function normalizeCacheContinuityImpact(value) {
  if (value?.status !== "available") {
    return unavailableCacheContinuityImpact(value?.errorCode);
  }
  if (finite(value.minimumGapSeconds, null)
      !== CACHE_CONTINUITY_MINIMUM_GAP_SECONDS
      || finite(value.maximumRetainedCacheRatio, null)
        !== CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO
      || finite(value.outcomeDisplayMaximumGapSeconds, null)
        !== CACHE_CONTINUITY_OUTCOME_DISPLAY_MAXIMUM_GAP_SECONDS
      || count(value.recentDetailLimit, null) !== CACHE_SWITCH_RECENT_LIMIT) {
    return unavailableCacheContinuityImpact("methodology_mismatch");
  }
  const periods = array(value.periods)
    .slice(0, 5)
    .flatMap((period) => {
      if (!CACHE_SWITCH_PERIOD_IDS.has(period?.periodId)) return [];
      const summary = normalizeCacheContinuitySummary(period);
      return summary === null ? [] : [{
        status: "available",
        errorCode: null,
        periodId: period.periodId,
        periodLabel: text(period.periodLabel, "Recorded period"),
        ...summary,
        allowanceImpact: period.periodId === "7d"
          ? summary.allowanceImpact
          : unavailableAllowanceImpact("period_denominator_mismatch"),
        minimumGapSeconds: CACHE_CONTINUITY_MINIMUM_GAP_SECONDS,
        maximumRetainedCacheRatio: CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO,
        outcomeDisplayMaximumGapSeconds:
          CACHE_CONTINUITY_OUTCOME_DISPLAY_MAXIMUM_GAP_SECONDS,
        recentDetailLimit: CACHE_SWITCH_RECENT_LIMIT,
        periods: []
      }];
    });
  const selected = normalizeCacheContinuitySummary(value);
  const periodId = CACHE_SWITCH_PERIOD_IDS.has(value?.periodId)
    ? value.periodId
    : null;
  if (selected === null || periodId === null) {
    return { ...unavailableCacheContinuityImpact(), periods };
  }
  return {
    status: "available",
    errorCode: null,
    periodId,
    periodLabel: text(value.periodLabel, "Recorded period"),
    ...selected,
    allowanceImpact: periodId === "7d"
      ? selected.allowanceImpact
      : unavailableAllowanceImpact("period_denominator_mismatch"),
    minimumGapSeconds: CACHE_CONTINUITY_MINIMUM_GAP_SECONDS,
    maximumRetainedCacheRatio: CACHE_SWITCH_MAXIMUM_RETAINED_CACHE_RATIO,
    outcomeDisplayMaximumGapSeconds:
      CACHE_CONTINUITY_OUTCOME_DISPLAY_MAXIMUM_GAP_SECONDS,
    recentDetailLimit: CACHE_SWITCH_RECENT_LIMIT,
    periods
  };
}

const OBSERVED_SPEED_KEYS = Object.freeze(["standard", "fast", "unknown"]);
// Published Priority (Fast) API price ratios over Standard, mirrored so the
// dashboard never has to trust a server-supplied number to explain its own
// arithmetic. Keys are canonical registered models; uncovered model/context/
// date evidence occupies the separate disclosed assumed-2x bucket.
const FAST_MODE_MULTIPLIERS = Object.freeze({
  "gpt-4.1": 1.75,
  "gpt-4.1-mini": 1.75,
  "gpt-4.1-nano": 2,
  "gpt-4o": 1.7,
  "gpt-5": 2,
  "gpt-5-mini": 1.8,
  "gpt-5.1": 2,
  "gpt-5.1-codex": 2,
  "gpt-5.2": 2,
  "gpt-5.4": 2,
  "gpt-5.4-mini": 2,
  "gpt-5.5": 2.5,
  "gpt-5.6-luna": 2,
  "gpt-5.6-sol": 2,
  "gpt-5.6-terra": 2,
  "gpt-6-astra": 2
});
const FAST_MODE_FAMILY_KEYS = Object.freeze([
  ...Object.keys(FAST_MODE_MULTIPLIERS), "unsupported"
]);
const FAST_MODE_ASSUMED_MULTIPLIER = 2;
const FAST_MODE_METRIC_LABEL = "Speed-priced API-price equivalent";
const FAST_MODE_METRIC_SHORT_LABEL = "Speed-priced API equivalent";
const FAST_MODE_STANDARD_METRIC_LABEL = "Standard-rate API-price equivalent";
const FAST_MODE_METRIC_EXPLAINER =
  "Standard-rate API prices, with Fast increments priced at the published Priority API rate for the exact model, context, and date. Where no eligible Priority rate exists, a disclosed assumed 2x Standard is used. This is a comparison, not a bill.";
const ALLOWANCE_SCENARIOS = Object.freeze([
  "unresolved_as_standard",
  "unresolved_as_fast"
]);
const ALLOWANCE_BASIS_FAMILY_ID =
  "codex_primary:speed_priced_api_equivalent:v3:priority_card_ratio_2026_08_30:event_time:observed_declared_scenario";
const TIMELINE_ALLOWANCE_WEIGHTING_SCHEMA_VERSION =
  "quota-weighted-timeline-v0.1";
const PLAN_SCOPED_TIMELINE_SCHEMA_VERSION =
  "local-plan-scoped-accounting-timeline-v1";
const PLAN_SCOPED_ATTRIBUTION_METHOD_VERSION = "plan-era-v1";
const TIMELINE_WEIGHTING_STATUS_BY_CODE = Object.freeze([
  "complete",
  "partial",
  "unknown"
]);

function allowanceBasisId(scenario) {
  return `${ALLOWANCE_BASIS_FAMILY_ID}:${scenario}`;
}

function normalizeAllowanceCoverage(value, usageEvents) {
  const coverage = {
    totalEvents: count(value?.totalEvents, null),
    observedEvents: count(value?.observedEvents, null),
    declaredFromConfigEvents: count(
      value?.declaredFromConfigEvents,
      null
    ),
    assumedEvents: count(
      value?.assumedEvents,
      null
    ),
    inferredEvents: count(value?.inferredEvents, null),
    unknownEvents: count(value?.unknownEvents, null)
  };
  if (Object.values(coverage).includes(null)
      || coverage.totalEvents !== usageEvents
      || coverage.inferredEvents > coverage.unknownEvents
      || coverage.observedEvents
        + coverage.declaredFromConfigEvents
        + coverage.assumedEvents
        + coverage.unknownEvents !== usageEvents) return null;
  return {
    ...coverage,
    observedSharePercent: usageEvents === 0
      ? null
      : coverage.observedEvents / usageEvents * 100,
    unknownSharePercent: usageEvents === 0
      ? null
      : coverage.unknownEvents / usageEvents * 100
  };
}

function normalizeAllowanceScenario(value, scenario, usageEvents, standardUsd) {
  const sourceWeightingStatus = ["complete", "partial", "unknown"].includes(
    value?.sourceWeightingStatus
  ) ? value.sourceWeightingStatus : null;
  const quotaWeightedUsd = nonNegative(value?.quotaWeightedUsd, null);
  const coveredSubtotalUsd = nonNegative(value?.coveredSubtotalUsd, null);
  const coverage = normalizeAllowanceCoverage(value?.coverage, usageEvents);
  if (value?.basisId !== allowanceBasisId(scenario)
      || sourceWeightingStatus === null || coveredSubtotalUsd === null
      || coverage === null
      || coveredSubtotalUsd > standardUsd * 2.5 + 0.00002
      || (sourceWeightingStatus === "complete"
        ? quotaWeightedUsd === null
          || Math.abs(coveredSubtotalUsd - quotaWeightedUsd) > 0.00002
          || quotaWeightedUsd + 0.00002 < standardUsd
          || quotaWeightedUsd > standardUsd * 2.5 + 0.00002
        : quotaWeightedUsd !== null)) return null;
  return {
    basisId: allowanceBasisId(scenario),
    sourceWeightingStatus,
    quotaWeightedUsd,
    coveredSubtotalUsd,
    coverage
  };
}

function normalizeAllowanceWeighting(value, usageEvents, standardUsd) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.basisFamilyId !== ALLOWANCE_BASIS_FAMILY_ID
      || !["complete", "range", "unavailable"].includes(value.status)) {
    return null;
  }
  const scenarios = Object.fromEntries(ALLOWANCE_SCENARIOS.map((scenario) => [
    scenario,
    normalizeAllowanceScenario(
      value.scenarios?.[scenario],
      scenario,
      usageEvents,
      standardUsd
    )
  ]));
  if (Object.values(scenarios).includes(null)) return null;
  const selectedScenario = ALLOWANCE_SCENARIOS.includes(value.selectedScenario)
    ? value.selectedScenario
    : null;
  const selectedUsd = nonNegative(value.selectedUsd, null);
  const rangeLower = nonNegative(value.rangeUsd?.lower, null);
  const rangeUpper = nonNegative(value.rangeUsd?.upper, null);
  if (value.status === "complete") {
    if (selectedScenario === null || selectedUsd === null
        || scenarios[selectedScenario].quotaWeightedUsd === null
        || Math.abs(
          selectedUsd - scenarios[selectedScenario].quotaWeightedUsd
        ) > 0.00002
        || value.rangeUsd !== null) return null;
  } else if (value.status === "range") {
    const values = ALLOWANCE_SCENARIOS.map(
      (scenario) => scenarios[scenario].quotaWeightedUsd
    );
    if (selectedScenario !== null || selectedUsd !== null
        || values.includes(null) || rangeLower === null || rangeUpper === null
        || Math.abs(rangeLower - Math.min(...values)) > 0.00002
        || Math.abs(rangeUpper - Math.max(...values)) > 0.00002) return null;
  } else if (selectedScenario !== null || selectedUsd !== null
      || value.rangeUsd !== null) return null;
  return {
    status: value.status,
    basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
    selectedScenario,
    selectedUsd,
    scenarios,
    rangeUsd: value.status === "range"
      ? { lower: rangeLower, upper: rangeUpper }
      : null
  };
}

function normalizeTimelineAllowanceWeightingEncoding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 4
      || value.schemaVersion
        !== TIMELINE_ALLOWANCE_WEIGHTING_SCHEMA_VERSION
      || value.basisFamilyId !== ALLOWANCE_BASIS_FAMILY_ID
      || !Array.isArray(value.scenarioOrder)
      || value.scenarioOrder.length !== ALLOWANCE_SCENARIOS.length
      || !value.scenarioOrder.every(
        (scenario, index) => scenario === ALLOWANCE_SCENARIOS[index]
      )
      || (value.selectedScenario !== null
        && !ALLOWANCE_SCENARIOS.includes(value.selectedScenario))) {
    return null;
  }
  return {
    schemaVersion: TIMELINE_ALLOWANCE_WEIGHTING_SCHEMA_VERSION,
    basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
    scenarioOrder: [...ALLOWANCE_SCENARIOS],
    selectedScenario: value.selectedScenario
  };
}

function normalizeCompactTimelineAllowanceScenario(
  tuple,
  offset,
  scenario,
  usageEvents,
  standardUsd
) {
  const sourceWeightingStatus = Number.isSafeInteger(tuple[offset])
    ? TIMELINE_WEIGHTING_STATUS_BY_CODE[tuple[offset]] ?? null
    : null;
  if (sourceWeightingStatus === null) return null;
  return normalizeAllowanceScenario({
    basisId: allowanceBasisId(scenario),
    sourceWeightingStatus,
    quotaWeightedUsd: tuple[offset + 1],
    coveredSubtotalUsd: tuple[offset + 2],
    coverage: {
      totalEvents: usageEvents,
      observedEvents: tuple[offset + 3],
      declaredFromConfigEvents: tuple[offset + 4],
      assumedEvents: tuple[offset + 5],
      inferredEvents: tuple[offset + 6],
      unknownEvents: tuple[offset + 7]
    }
  }, scenario, usageEvents, standardUsd);
}

function normalizeCompactTimelineAllowanceWeighting(
  value,
  encoding,
  usageEvents,
  standardUsd
) {
  if (!Array.isArray(value) || value.length !== 16) return null;
  const scenarios = Object.fromEntries(ALLOWANCE_SCENARIOS.map(
    (scenario, index) => [scenario,
      normalizeCompactTimelineAllowanceScenario(
        value,
        index * 8,
        scenario,
        usageEvents,
        standardUsd
      )]
  ));
  if (Object.values(scenarios).includes(null)) return null;
  const selectedScenario = encoding.selectedScenario;
  const scenarioValues = ALLOWANCE_SCENARIOS.map(
    (scenario) => scenarios[scenario].quotaWeightedUsd
  );
  const bothComplete = !scenarioValues.includes(null);
  const status = selectedScenario === null
    ? bothComplete ? "range" : "unavailable"
    : scenarios[selectedScenario].quotaWeightedUsd === null
      ? "unavailable"
      : "complete";
  const selectedUsd = status === "complete"
    ? scenarios[selectedScenario].quotaWeightedUsd
    : null;
  const rangeUsd = status === "range"
    ? {
      lower: Math.min(...scenarioValues),
      upper: Math.max(...scenarioValues)
    }
    : null;
  return normalizeAllowanceWeighting({
    status,
    basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
    selectedScenario: status === "complete" ? selectedScenario : null,
    selectedUsd,
    scenarios,
    rangeUsd
  }, usageEvents, standardUsd);
}

function normalizeSpeedWeighting(value) {
  return Object.fromEntries(OBSERVED_SPEED_KEYS.map((speed) => [
    speed,
    Object.fromEntries(FAST_MODE_FAMILY_KEYS.map((family) => {
      const cell = value?.[speed]?.[family] ?? {};
      return [family, {
        events: count(cell.events, 0),
        apiPriceEquivalentUsd: nonNegative(cell.apiPriceEquivalentUsd, 0)
      }];
    }))
  ]));
}

function normalizeFastMode(value) {
  const coverage = value?.coverage ?? {};
  const inference = value?.inference ?? {};
  return {
    unresolvedScenario: value?.unresolvedScenario === "unresolved_as_fast"
      ? "unresolved_as_fast"
      : "unresolved_as_standard",
    // Codex records a tier only when the setting is applied or changed, never
    // at session start, so turns before the first change in a session carry no
    // recorded tier. The dashboard states this itself rather than reflecting a
    // server claim.
    logRecordsTierChangesOnly: true,
    metricLabel: FAST_MODE_METRIC_LABEL,
    metricShortLabel: FAST_MODE_METRIC_SHORT_LABEL,
    metricExplainer: FAST_MODE_METRIC_EXPLAINER,
    standardMetricLabel: FAST_MODE_STANDARD_METRIC_LABEL,
    multipliers: { ...FAST_MODE_MULTIPLIERS },
    quotaWeightedApiPriceEquivalentUsd: nonNegative(
      value?.quotaWeightedApiPriceEquivalentUsd,
      null
    ),
    standardApiPriceEquivalentUsd: nonNegative(
      value?.standardApiPriceEquivalentUsd,
      0
    ),
    unweightedUnknownApiPriceEquivalentUsd: nonNegative(
      value?.unweightedUnknownApiPriceEquivalentUsd,
      0
    ),
    weightingStatus: ["complete", "partial", "unknown"].includes(value?.weightingStatus)
      ? value.weightingStatus
      : "unknown",
    assumedRatioStandardApiPriceEquivalentUsd: nonNegative(
      value?.assumedRatioStandardApiPriceEquivalentUsd,
      0
    ),
    appliedMultipliers: {
      ...Object.fromEntries(
        Object.keys(FAST_MODE_MULTIPLIERS)
          .filter((family) => finite(value?.appliedMultipliers?.[family], null) !== null)
          .map((family) => [family, FAST_MODE_MULTIPLIERS[family]])
      ),
      ...(finite(value?.appliedMultipliers?.unsupported, null) !== null
        ? { unsupported: FAST_MODE_ASSUMED_MULTIPLIER }
        : {})
    },
    coverage: {
      totalEvents: count(coverage.totalEvents, 0),
      observedEvents: count(coverage.observedEvents, 0),
      declaredFromConfigEvents: count(coverage.declaredFromConfigEvents, 0),
      assumedEvents: count(coverage.assumedEvents, 0),
      inferredEvents: count(coverage.inferredEvents, 0),
      unknownEvents: count(coverage.unknownEvents, 0),
      observedSharePercent: nonNegative(coverage.observedSharePercent, null),
      unknownSharePercent: nonNegative(coverage.unknownSharePercent, null)
    },
    inference: {
      status: ["inferred", "insufficient_signal", "not_run"].includes(inference.status)
        ? inference.status
        : "not_run",
      reasonCode: text(inference.reasonCode, ""),
      inferredFastWindows: count(inference.inferredFastWindows, 0),
      referenceWindowCount: count(inference.referenceWindowCount, 0),
      scoredWindowCount: count(inference.scoredWindowCount, 0),
      relativeTolerance: nonNegative(inference.relativeTolerance, 0),
      // Window-level labels are never folded into the weighted total.
      appliedToWeighting: false
    }
  };
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

function normalizeLocalUsageTimeline(value, weightingEncoding = undefined, maximumRows = 3_000) {
  if (weightingEncoding === null) return [];
  const rows = [];
  for (const row of array(value).slice(-maximumRows)) {
    const startAt = text(row?.startAt, "");
    const endAt = text(row?.endAt, "");
    const startMs = Date.parse(startAt);
    const endMs = Date.parse(endAt);
    const usageEvents = count(row?.usageEvents, null);
    const totalTokens = count(row?.totalTokens, null);
    const cost = nonNegative(row?.apiPriceEquivalentUsd, null);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs
        || usageEvents === null || totalTokens === null || cost === null) {
      return [];
    }
    const hasAllowanceWeighting = Object.hasOwn(row ?? {}, "allowanceWeighting");
    const allowanceWeighting = weightingEncoding === undefined
      ? hasAllowanceWeighting
        ? normalizeAllowanceWeighting(
          row?.allowanceWeighting,
          usageEvents,
          cost
        )
        : null
      : normalizeCompactTimelineAllowanceWeighting(
        row?.allowanceWeighting,
        weightingEncoding,
        usageEvents,
        cost
      );
    if (allowanceWeighting === null
        && (weightingEncoding !== undefined || hasAllowanceWeighting)) {
      return [];
    }
    rows.push({
      startAt,
      endAt,
      usageEvents,
      totalTokens,
      apiPriceEquivalentUsd: cost,
      allowanceWeighting,
      components: normalizeLocalComponents(row.components),
      pricingCoverage: {
        fullyPricedEvents: count(row?.pricingCoverage?.fullyPricedEvents, 0),
        partiallyPricedEvents: count(row?.pricingCoverage?.partiallyPricedEvents, 0),
        unpricedEvents: count(row?.pricingCoverage?.unpricedEvents, 0)
      }
    });
  }
  return rows;
}

function unavailableAllowanceCapacity(reason = "allowance_capacity_unavailable") {
  return {
    status: "unavailable",
    reason,
    basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
    selectedScenario: null,
    scenarios: {
      unresolved_as_standard: null,
      unresolved_as_fast: null
    },
    planScope: null,
    stale: null,
    accountAttribution: {
      status: "historical_unattributed",
      maySpanMultipleAccounts: true
    }
  };
}

function normalizePlanScope(value) {
  const planType = normalizePlanType(value?.planType);
  const cohortId = typeof value?.cohortId === "string"
      && /^[0-9a-f]{64}$/u.test(value.cohortId)
    ? value.cohortId
    : null;
  const rawGeneration = value?.sourceGeneration;
  const sourceGeneration = Number.isSafeInteger(rawGeneration)
      && rawGeneration >= 0
    ? String(rawGeneration)
    : typeof rawGeneration === "string"
        && /^[A-Za-z0-9._:-]{1,256}$/u.test(rawGeneration)
      ? rawGeneration
      : "";
  const sourceGenerationFingerprint = text(
    value?.sourceGenerationFingerprint,
    ""
  );
  if (value?.methodVersion !== PLAN_SCOPED_ATTRIBUTION_METHOD_VERSION
      || planType === "unknown"
      || value?.basisFamilyId !== ALLOWANCE_BASIS_FAMILY_ID
      || cohortId === null
      || sourceGeneration === ""
      || sourceGenerationFingerprint === "") return null;
  return {
    methodVersion: PLAN_SCOPED_ATTRIBUTION_METHOD_VERSION,
    planType,
    basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
    cohortId,
    sourceGeneration,
    sourceGenerationFingerprint
  };
}

function matchingPlanScope(left, right) {
  return left !== null && right !== null
    && left.methodVersion === right.methodVersion
    && left.planType === right.planType
    && left.basisFamilyId === right.basisFamilyId
    && left.cohortId === right.cohortId
    && left.sourceGeneration === right.sourceGeneration
    && left.sourceGenerationFingerprint
      === right.sourceGenerationFingerprint;
}

function normalizeAllowanceCapacityScenario(value, scenario) {
  if (value === null || value === undefined) return null;
  const medianCapacityUsd = nonNegative(value?.medianCapacityUsd, null);
  const lower = nonNegative(value?.plausibleRangeUsd?.lower, null);
  const upper = nonNegative(value?.plausibleRangeUsd?.upper, null);
  const qualifyingResets = count(value?.qualifyingResets, null);
  const cohortId = typeof value?.cohortId === "string"
      && /^[0-9a-f]{64}$/u.test(value.cohortId)
    ? value.cohortId
    : null;
  const validation = value?.validation ?? {};
  const validationFields = [
    "sameResetHoldoutMeanAbsoluteErrorPercentagePoints",
    "priorResetMeanAbsoluteErrorPercentagePoints",
    "priorResetAbsoluteBiasPercentagePoints",
    "forecastErrorP80PercentagePoints"
  ];
  const normalizedValidation = Object.fromEntries(validationFields.map((key) => [
    key,
    finite(validation[key], null)
  ]));
  const scoredPriorResets = count(validation.scoredPriorResets, null);
  const scoredPriorPoints = count(validation.scoredPriorPoints, null);
  if (value?.basisId !== allowanceBasisId(scenario)
      || medianCapacityUsd === null || medianCapacityUsd <= 0
      || lower === null || lower <= 0 || upper === null
      || lower > medianCapacityUsd || medianCapacityUsd > upper
      || qualifyingResets === null || qualifyingResets < 1
      || cohortId === null
      || scoredPriorResets === null || scoredPriorPoints === null
      || normalizedValidation
        .sameResetHoldoutMeanAbsoluteErrorPercentagePoints === null) {
    return null;
  }
  return {
    basisId: allowanceBasisId(scenario),
    medianCapacityUsd,
    plausibleRangeUsd: { lower, upper },
    qualifyingResets,
    cohortId,
    validation: {
      ...normalizedValidation,
      scoredPriorResets,
      scoredPriorPoints
    }
  };
}

const LOCAL_ACCOUNTING_PROJECTION_REASONS = new Set([
  "cache_accounting_semantics_outdated",
  "current_projection_unavailable",
  "local_unified_index_deferred",
  "local_unified_index_generation_invalid",
  "local_unified_index_generation_mismatch",
  "local_unified_index_missing",
  "local_unified_index_schema_invalid",
  "local_unified_index_schema_newer",
  "local_unified_index_unavailable",
  "typed_tool_history_partial",
  "unified_index_generation_incomplete",
  "unified_index_partial"
]);

function safeLocalProjectionReason(value, fallback) {
  return LOCAL_ACCOUNTING_PROJECTION_REASONS.has(value) ? value : fallback;
}

function normalizeAccountingProjection(value, {
  allowImplicitDemoProjection = false
} = {}) {
  // Only the synthetic demo contract may omit this attestation. Real local
  // evidence must fail closed: otherwise a mixed-version or truncated
  // response can turn placeholder zeroes into apparently measured usage.
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (!allowImplicitDemoProjection) {
      return {
        status: "unavailable",
        reason: "local_unified_index_unavailable",
        terminal: true,
        retainedAt: null,
        coveredAt: null
      };
    }
    return {
      status: "available",
      reason: null,
      terminal: false,
      retainedAt: null,
      coveredAt: null
    };
  }
  const status = ["available", "retained", "unavailable"].includes(value.status)
    ? value.status
    : "unavailable";
  if (status === "available"
      && value.reason === null
      && value.terminal === false) {
    return {
      status,
      reason: null,
      terminal: false,
      retainedAt: null,
      coveredAt: null
    };
  }
  // `available` is an attestation, not a display preference. A contradictory
  // or incomplete attestation must not make placeholder zeroes look like
  // measured evidence merely because its status string survived validation.
  if (status === "available") {
    return {
      status: "unavailable",
      reason: "local_unified_index_unavailable",
      terminal: true,
      retainedAt: null,
      coveredAt: null
    };
  }
  const startAt = canonicalInstant(value?.coveredAt?.startAt);
  const endAt = canonicalInstant(value?.coveredAt?.endAt);
  return {
    status,
    reason: safeLocalProjectionReason(
      value.reason,
      "local_unified_index_unavailable"
    ),
    terminal: value.terminal === true,
    retainedAt: canonicalInstant(value.retainedAt),
    coveredAt: startAt !== null && endAt !== null
        && Date.parse(startAt) <= Date.parse(endAt)
      ? { startAt, endAt }
      : null
  };
}

// Staleness provenance attached to projections served from the previous app
// version's cache while the current rebuild runs. Normalized as a closed
// shape (flag, reason, semantic version, computed-at, covered span) or null; a block
// missing its identity is dropped rather than shown as an unlabeled serve.
function normalizeStaleProvenance(value) {
  if (value?.stale !== true) return null;
  const schemaVersion = text(value.schemaVersion, "");
  const computedAt = text(value.computedAt, "");
  if (schemaVersion === "" || computedAt === "") return null;
  return {
    stale: true,
    reason: safeLocalProjectionReason(
      value.reason,
      "cache_accounting_semantics_outdated"
    ),
    schemaVersion,
    computedAt,
    coveredAt: {
      startAt: text(value.coveredAt?.startAt, ""),
      endAt: text(value.coveredAt?.endAt, "")
    }
  };
}

function normalizeTimelineHistory(value) {
  const status = ["complete", "partial", "loading", "unavailable"]
    .includes(value?.status)
    ? value.status
    : "unavailable";
  const reason = status === "complete"
    ? null
    : safeLocalProjectionReason(
      value?.reason,
      status === "loading"
        ? "local_unified_index_deferred"
        : "local_unified_index_unavailable"
    );
  const startAt = canonicalInstant(value?.coveredAt?.startAt);
  const endAt = canonicalInstant(value?.coveredAt?.endAt);
  const evidenceAvailable = ["complete", "partial"].includes(status);
  return {
    status,
    reason,
    source: text(value?.source, ""),
    coveredAt: startAt !== null && endAt !== null
        && Date.parse(startAt) <= Date.parse(endAt)
      ? { startAt, endAt }
      : null,
    generatedAt: canonicalInstant(value?.generatedAt),
    usageEvents: evidenceAvailable ? count(value?.usageEvents, null) : null,
    sourceCount: evidenceAvailable ? count(value?.sourceCount, null) : null,
    indexBytes: evidenceAvailable ? count(value?.indexBytes, null) : null,
    boundedDays: status === "unavailable"
      ? count(value?.boundedDays, null)
      : null
  };
}

function normalizeAllowanceCapacity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.basisFamilyId !== ALLOWANCE_BASIS_FAMILY_ID
      || !["available", "range", "unavailable"].includes(value.status)
      || value.accountAttribution?.status !== "historical_unattributed"
      || value.accountAttribution?.maySpanMultipleAccounts !== true) {
    return unavailableAllowanceCapacity("allowance_capacity_invalid");
  }
  const scenarios = Object.fromEntries(ALLOWANCE_SCENARIOS.map((scenario) => [
    scenario,
    normalizeAllowanceCapacityScenario(value.scenarios?.[scenario], scenario)
  ]));
  const selectedScenario = ALLOWANCE_SCENARIOS.includes(value.selectedScenario)
    ? value.selectedScenario
    : null;
  const planScope = normalizePlanScope(value.planScope);
  const stale = normalizeStaleProvenance(value.stale);
  // Prior cache formats predate plan-scoped timelines. Retain their explicitly
  // stale scalar for historical display, never as a current plan numerator.
  const legacyStale = value.planScope == null && stale !== null;
  if (value.status === "available") {
    if (selectedScenario === null || scenarios[selectedScenario] === null
        || (!legacyStale && (planScope === null
          || planScope.cohortId !== scenarios[selectedScenario].cohortId))) {
      return unavailableAllowanceCapacity("allowance_capacity_invalid");
    }
  } else if (selectedScenario !== null || planScope !== null) {
    return unavailableAllowanceCapacity("allowance_capacity_invalid");
  }
  if (value.status === "range"
      && (Object.values(scenarios).includes(null)
        || scenarios.unresolved_as_standard.qualifyingResets
          !== scenarios.unresolved_as_fast.qualifyingResets
        || scenarios.unresolved_as_standard.cohortId
          !== scenarios.unresolved_as_fast.cohortId)) {
    return unavailableAllowanceCapacity("allowance_capacity_invalid");
  }
  return {
    status: value.status,
    reason: value.status === "unavailable"
      ? text(value.reason, "allowance_capacity_unavailable")
      : null,
    basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
    selectedScenario,
    scenarios,
    planScope,
    stale,
    accountAttribution: {
      status: "historical_unattributed",
      maySpanMultipleAccounts: true
    }
  };
}

function unavailablePlanScopedTimeline(reason = "plan_scoped_timeline_unavailable") {
  return {
    schemaVersion: PLAN_SCOPED_TIMELINE_SCHEMA_VERSION,
    status: "unavailable",
    reason,
    planScope: null,
    usage: [],
    quota: [],
    comparisonIntervals: []
  };
}

function normalizePlanScopedTimeline(value, weightingEncoding, capacity) {
  if (value?.schemaVersion !== PLAN_SCOPED_TIMELINE_SCHEMA_VERSION
      || value?.status !== "available" || value.reason !== null
      || value.encoding !== "plan_bucket_v1") {
    return unavailablePlanScopedTimeline();
  }
  const planScope = normalizePlanScope(value.planScope);
  const capacityScope = capacity?.status === "available"
    ? capacity.planScope : null;
  if (planScope === null || capacityScope === null
      || !matchingPlanScope(planScope, capacityScope)) {
    return unavailablePlanScopedTimeline("plan_scoped_timeline_scope_mismatch");
  }
  if (!Array.isArray(value.usage) || value.usage.length > 100_000
      || !Array.isArray(value.quota) || value.quota.length > 100_000
      || !Array.isArray(value.comparisonIntervals) || value.comparisonIntervals.length > 100_000) {
    return unavailablePlanScopedTimeline("plan_scoped_timeline_invalid");
  }
  const comparisonIntervals = [];
  let priorEnd = -Infinity;
  for (const interval of value.comparisonIntervals) {
    if (!Array.isArray(interval) || interval.length !== 2
        || !interval.every((ms) => Number.isSafeInteger(ms)
          && ms % 900_000 === 0 && Number.isFinite(new Date(ms).getTime()))
        || interval[0] < priorEnd || interval[1] <= interval[0]) {
      return unavailablePlanScopedTimeline("plan_scoped_timeline_invalid");
    }
    comparisonIntervals.push([...interval]);
    priorEnd = interval[1];
  }
  const decodedUsage = value.usage.map(decodePlanTimelineUsage);
  if (decodedUsage.includes(null)) return unavailablePlanScopedTimeline("plan_scoped_timeline_invalid");
  const usage = normalizeLocalUsageTimeline(decodedUsage, weightingEncoding, 100_000);
  const decodedQuota = [];
  for (const row of value.quota) {
    if (!Array.isArray(row) || row.length !== 3
        || !row.every((n) => typeof n === "number" && Number.isFinite(n))
        || !Number.isSafeInteger(row[0]) || !Number.isFinite(new Date(row[0]).getTime())
        || !Number.isFinite(new Date(row[1] * 1000).getTime())
        || row[2] < 0 || row[2] > 100) return unavailablePlanScopedTimeline("plan_scoped_timeline_invalid");
    decodedQuota.push({ observedAt: new Date(row[0]).toISOString(), resetAt: new Date(row[1] * 1000).toISOString(),
      usedPercent: row[2], remainingPercent: 100 - row[2], limitId: "codex", durationMinutes: 10_080,
      slot: "unknown", planType: planScope.planType, accountAttribution: "unattributed" });
  }
  const quota = normalizeLocalQuotaTimeline(decodedQuota, 100_000);
  if (usage.length !== value.usage.length || quota.length !== value.quota.length
      || quota.some((row) => row.planType !== planScope.planType)) {
    return unavailablePlanScopedTimeline("plan_scoped_timeline_invalid");
  }
  let intervalAt = 0;
  priorEnd = -Infinity;
  for (const row of usage) {
    const start = Date.parse(row.startAt);
    const end = Date.parse(row.endAt);
    while (intervalAt < comparisonIntervals.length
        && comparisonIntervals[intervalAt][1] <= start) intervalAt += 1;
    const interval = comparisonIntervals[intervalAt];
    if (start < priorEnd || !interval || start < interval[0] || end > interval[1]) {
      return unavailablePlanScopedTimeline("plan_scoped_timeline_invalid");
    }
    priorEnd = end;
  }
  intervalAt = 0;
  priorEnd = -Infinity;
  for (const row of quota) {
    const at = Date.parse(row.observedAt);
    while (intervalAt < comparisonIntervals.length
        && comparisonIntervals[intervalAt][1] <= at) intervalAt += 1;
    const interval = comparisonIntervals[intervalAt];
    if (at <= priorEnd || !interval || at < interval[0] || at >= interval[1]) {
      return unavailablePlanScopedTimeline("plan_scoped_timeline_invalid");
    }
    priorEnd = at;
  }
  return {
    schemaVersion: PLAN_SCOPED_TIMELINE_SCHEMA_VERSION,
    status: "available",
    reason: null,
    planScope,
    usage,
    quota,
    comparisonIntervals
  };
}

function decodePlanTimelineUsage(row) {
  if (!Array.isArray(row) || row.length !== 16
      || row.some((n) => typeof n !== "number" || !Number.isFinite(n))
      || !Number.isSafeInteger(row[0]) || row[0] % 900_000 !== 0
      || !Number.isFinite(new Date(row[0] + 900_000).getTime())
      || row.slice(1).some((n) => n < 0)
      || [1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 14, 15].some((i) => !Number.isSafeInteger(row[i]))
      || row[1] < 1 || row[11] + row[12] > row[1] || row[13] + row[14] > row[1]) return null;
  const priced = row[13] + row[14] === row[1];
  return {
    startAt: new Date(row[0]).toISOString(), endAt: new Date(row[0] + 900_000).toISOString(),
    usageEvents: row[1], totalTokens: row[15], apiPriceEquivalentUsd: row[8],
    components: Object.fromEntries(LOCAL_COMPONENT_KEYS.map((key, i) => [key, row[i + 2]])),
    pricingCoverage: { fullyPricedEvents: row[13], partiallyPricedEvents: row[14],
      unpricedEvents: row[1] - row[13] - row[14] },
    // Existing weighting encoding: complete=0, unknown=2; unpriced events
    // withhold the whole bucket, while unresolved speed remains a scenario.
    allowanceWeighting: [row[9], row[10]].flatMap((usd) => [
      priced ? 0 : 2, priced ? usd : null, priced ? usd : 0,
      priced ? row[11] : 0, priced ? row[12] : 0,
      priced ? row[1] - row[11] - row[12] : 0, 0, priced ? 0 : row[1],
    ]),
  };
}

function normalizeLocalTimeline(value = {}) {
  const hasWeightingEncoding = Object.hasOwn(
    value,
    "allowanceWeightingEncoding"
  );
  const weightingEncoding = hasWeightingEncoding
    ? normalizeTimelineAllowanceWeightingEncoding(
      value.allowanceWeightingEncoding
    )
    : undefined;
  const usage = normalizeLocalUsageTimeline(value.usage, weightingEncoding);
  const calibrationUsage = normalizeLocalUsageTimeline(
    value.calibrationUsage,
    weightingEncoding
  );
  const allowanceCapacity = normalizeAllowanceCapacity(value.allowanceCapacity);
  const planScoped = normalizePlanScopedTimeline(
    value.planScoped,
    weightingEncoding,
    allowanceCapacity
  );
  const quota = normalizeLocalQuotaTimeline(value.quota);
  return {
    bucketMinutes: count(value.bucketMinutes, 15),
    coveredAt: {
      startAt: text(value?.coveredAt?.startAt, ""),
      endAt: text(value?.coveredAt?.endAt, "")
    },
    usage,
    calibrationUsage,
    allowanceCapacity,
    planScoped,
    quota,
    history: normalizeTimelineHistory(value.history)
  };
}

function normalizeLocalQuotaTimeline(value, maximumRows = 10_000) {
  return array(value).slice(-maximumRows).flatMap((row) => {
    const observedAt = text(row?.observedAt, "");
    const usedPercent = finite(row?.usedPercent, null);
    const remainingPercent = finite(row?.remainingPercent, null);
    const durationCandidate = count(row?.durationMinutes, null);
    const durationMinutes = isValidQuotaWindowDuration(durationCandidate)
      ? durationCandidate
      : null;
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
      limitId: normalizeQuotaLimitId(row?.limitId),
      slot: ["primary", "secondary", "unknown"].includes(row?.slot)
        ? row.slot
        : "unknown",
      planType: normalizePlanType(row?.planType),
      accountAttribution: row?.accountAttribution === "attributed_pseudonymous"
        ? "attributed_pseudonymous"
        : "unattributed"
    }];
  });
}

/**
 * One model-usage row set, with the three facts a display surface needs to
 * tell four different situations apart.
 *
 * `apiPriceEquivalentUsd` deliberately falls back to `null`, not `0`: a row
 * that reported no usable figure is missing, and rendering it as a priced zero
 * is a different and untrue claim.
 */
function normalizeLocalModelUsage(rows) {
  return array(rows).slice(0, 32).flatMap((row) => {
    if (!LOCAL_MODELS.has(row?.model)) return [];
    const allowanceTrack = LOCAL_MODEL_ALLOWANCE_TRACKS.has(row.allowanceTrack)
      ? row.allowanceTrack
      : "primary";
    return [{
      model: row.model,
      events: count(row.events, 0),
      totalTokens: count(row.totalTokens, 0),
      apiPriceEquivalentUsd: nonNegative(row.apiPriceEquivalentUsd, null),
      pricingStatus: LOCAL_MODEL_PRICING_STATUSES.has(row.pricingStatus)
        ? row.pricingStatus
        : (row.model === "unknown" ? "unrecognized" : "priced"),
      allowanceTrack,
      // A separate allowance is not substitutable for the primary pool, so no
      // dollar comparison against it is honest. Only an explicit `false` or a
      // Spark row withholds the figure.
      apiPriceEquivalentApplicable:
        row.apiPriceEquivalentApplicable !== false && allowanceTrack !== "spark",
      components: normalizeLocalModelComponents(row.components),
      componentCosts: normalizeLocalModelComponentCosts(row.componentCosts)
    }];
  });
}

function sideChatRange(value, point) {
  const lower = nonNegative(value?.lower, null);
  const upper = nonNegative(value?.upper, null);
  return lower !== null && upper !== null && lower <= point && point <= upper
    ? { lower, upper }
    : null;
}

function sideChatAssumptionsMatch(value) {
  for (const [group, expected] of Object.entries(SIDE_CHAT_ASSUMPTIONS)) {
    for (const [key, number] of Object.entries(expected)) {
      if (finite(value?.[group]?.[key], null) !== number) return false;
    }
  }
  return true;
}

function unavailableSideChatHistoricalGap(errorCode = null) {
  return {
    status: "unavailable",
    errorCode: typeof errorCode === "string"
        && CACHE_SWITCH_SAFE_CODE.test(errorCode)
      ? errorCode
      : null
  };
}

function closeNumber(left, right, tolerance = 1e-6) {
  return Number.isFinite(left) && Number.isFinite(right)
    && Math.abs(left - right) <= tolerance;
}

function normalizeSideChatHistoricalGap(value) {
  if (value?.status !== "available") {
    return unavailableSideChatHistoricalGap(value?.errorCode);
  }
  const date = typeof value?.date === "string"
      && /^\d{4}-\d{2}-\d{2}$/u.test(value.date)
    ? value.date
    : null;
  const startAt = canonicalInstant(value?.startAt);
  const endAt = canonicalInstant(value?.endAt);
  const startMs = Date.parse(startAt ?? "");
  const endMs = Date.parse(endAt ?? "");
  const durationHours = (endMs - startMs) / 3_600_000;
  const quota = value?.quota;
  const quotaRows = [
    quota?.startBefore,
    quota?.startAfter,
    quota?.endBefore,
    quota?.endAfter
  ].map((row) => ({
    observedAt: canonicalInstant(row?.observedAt),
    usedPercent: finite(row?.usedPercent, null)
  }));
  const quotaTimes = quotaRows.map((row) => Date.parse(row.observedAt ?? ""));
  const minimumMovement = finite(
    quota?.minimumMovementPercentagePoints,
    null
  );
  const maximumMovement = finite(
    quota?.maximumMovementPercentagePoints,
    null
  );
  const resetAt = canonicalInstant(quota?.resetAt);
  const exact = value?.exactUsage;
  const events = count(exact?.events, null);
  const sessions = count(exact?.sessions, null);
  const totalTokens = count(exact?.totalTokens, null);
  const standardCost = nonNegative(
    exact?.standardApiPriceEquivalentUsd,
    null
  );
  const allowanceWeighting = events === null || standardCost === null
    ? null
    : normalizeAllowanceWeighting(
      exact?.allowanceWeighting,
      events,
      standardCost
    );
  const weightedLower = nonNegative(
    exact?.quotaWeightedApiPriceEquivalentRangeUsd?.lower,
    null
  );
  const weightedUpper = nonNegative(
    exact?.quotaWeightedApiPriceEquivalentRangeUsd?.upper,
    null
  );
  const observedModels = array(exact?.observedModels)
    .filter((model) => LOCAL_MODELS.has(model));
  const speedKeys = ["fast", "standard", "unknown", "other"];
  const bySpeed = Object.fromEntries(speedKeys.map((speed) => {
    const row = exact?.bySpeed?.[speed];
    return [speed, {
      events: count(row?.events, null),
      totalTokens: count(row?.totalTokens, null),
      standardApiPriceEquivalentUsd: nonNegative(
        row?.standardApiPriceEquivalentUsd,
        null
      )
    }];
  }));
  const pricedEvents = count(exact?.pricingCoverage?.pricedEvents, null);
  const unpricedEvents = count(exact?.pricingCoverage?.unpricedEvents, null);
  const unsupportedEvents = count(
    exact?.speedWeightingCoverage?.unsupportedEvents,
    null
  );
  const unknownSpeedEvents = count(
    exact?.speedWeightingCoverage?.unknownSpeedEvents,
    null
  );
  const calibration = value?.calibration;
  const capacityScenarios = Object.fromEntries(
    ALLOWANCE_SCENARIOS.map((scenario) => {
      const row = calibration?.scenarios?.[scenario];
      return [scenario, {
        basisId: row?.basisId,
        generatedAt: canonicalInstant(row?.generatedAt),
        selectedCostBasis: row?.selectedCostBasis,
        medianWeeklyCapacityUsd: nonNegative(
          row?.medianWeeklyCapacityUsd,
          null
        ),
        plausibleWeeklyCapacityRangeUsd: {
          lower: nonNegative(
            row?.plausibleWeeklyCapacityRangeUsd?.lower,
            null
          ),
          upper: nonNegative(
            row?.plausibleWeeklyCapacityRangeUsd?.upper,
            null
          )
        },
        qualifyingResets: count(row?.qualifyingResets, null),
        cohortId: typeof row?.cohortId === "string"
            && /^[0-9a-f]{64}$/u.test(row.cohortId)
          ? row.cohortId
          : null
      }];
    })
  );
  const standardCapacity = capacityScenarios.unresolved_as_standard;
  const fastCapacity = capacityScenarios.unresolved_as_fast;
  const estimate = value?.estimate;
  const assumedMissingModel = LOCAL_MODELS.has(estimate?.assumedMissingModel)
    ? estimate.assumedMissingModel
    : null;
  const fastMultiplier = finite(estimate?.fastQuotaMultiplier, null);
  const comparison = estimate?.allowanceComparison;
  const comparisonStatus = ["complete", "range"].includes(comparison?.status)
    ? comparison.status
    : null;
  const comparisonSelectedScenario = ALLOWANCE_SCENARIOS.includes(
    comparison?.selectedScenario
  ) ? comparison.selectedScenario : null;
  const comparisonSelectedExpected = comparison
      ?.selectedExpectedPercentagePoints === null
    ? null
    : nonNegative(
      comparison?.selectedExpectedPercentagePoints,
      null
    );
  const comparisonScenarios = Object.fromEntries(
    ALLOWANCE_SCENARIOS.map((scenario) => {
      const row = comparison?.scenarios?.[scenario];
      if (row === null || row === undefined) return [scenario, null];
      return [scenario, {
        basisId: row?.basisId,
        numeratorUsd: nonNegative(row?.numeratorUsd, null),
        capacityUsd: nonNegative(row?.capacityUsd, null),
        expectedPercentagePoints: nonNegative(
          row?.expectedPercentagePoints,
          null
        )
      }];
    })
  );
  const comparisonRangeLower = comparison
      ?.expectedRangePercentagePoints === null
    ? null
    : nonNegative(
      comparison?.expectedRangePercentagePoints?.lower,
      null
    );
  const comparisonRangeUpper = comparison
      ?.expectedRangePercentagePoints === null
    ? null
    : nonNegative(
      comparison?.expectedRangePercentagePoints?.upper,
      null
    );
  const expectedLower = nonNegative(
    estimate?.exactCostImpliedMedianRangePercentagePoints?.lower,
    null
  );
  const expectedUpper = nonNegative(
    estimate?.exactCostImpliedMedianRangePercentagePoints?.upper,
    null
  );
  const unexplainedLower = finite(
    estimate?.unexplainedMedianRangePercentagePoints?.lower,
    null
  );
  const unexplainedUpper = finite(
    estimate?.unexplainedMedianRangePercentagePoints?.upper,
    null
  );
  const impliedMissing = estimate?.impliedMissingStandardApiEquivalentUsd
      === null
    ? null
    : nonNegative(estimate?.impliedMissingStandardApiEquivalentUsd, null);
  const impliedMissingWeighted = estimate
      ?.impliedMissingQuotaWeightedApiEquivalentUsd === null
    ? null
    : nonNegative(
      estimate?.impliedMissingQuotaWeightedApiEquivalentUsd,
      null
    );
  const sensitivityLower = nonNegative(
    estimate?.sensitivityRangeUsd?.lower,
    null
  );
  const sensitivityUpper = nonNegative(
    estimate?.sensitivityRangeUsd?.upper,
    null
  );
  const weightedSensitivityLower = nonNegative(
    estimate?.quotaWeightedSensitivityRangeUsd?.lower,
    null
  );
  const weightedSensitivityUpper = nonNegative(
    estimate?.quotaWeightedSensitivityRangeUsd?.upper,
    null
  );
  const speedEvents = speedKeys.reduce(
    (sum, speed) => sum + (bySpeed[speed].events ?? 0),
    0
  );
  const speedTokens = speedKeys.reduce(
    (sum, speed) => sum + (bySpeed[speed].totalTokens ?? 0),
    0
  );
  const speedCost = speedKeys.reduce(
    (sum, speed) => sum
      + (bySpeed[speed].standardApiPriceEquivalentUsd ?? 0),
    0
  );
  const weightedScenarioValues = allowanceWeighting === null
    ? []
    : ALLOWANCE_SCENARIOS.map(
      (scenario) => allowanceWeighting.scenarios[scenario].quotaWeightedUsd
    ).filter(Number.isFinite);
  const comparisonScenariosValid = allowanceWeighting !== null
    && ALLOWANCE_SCENARIOS.every((scenario) => {
      const row = comparisonScenarios[scenario];
      if (row === null) {
        return allowanceWeighting.scenarios[scenario].quotaWeightedUsd === null;
      }
      const capacity = capacityScenarios[scenario];
      return row.basisId === allowanceBasisId(scenario)
        && ![
          row.numeratorUsd,
          row.capacityUsd,
          row.expectedPercentagePoints
        ].includes(null)
        && row.capacityUsd > 0
        && closeNumber(
          row.numeratorUsd,
          allowanceWeighting.scenarios[scenario].quotaWeightedUsd
        )
        && closeNumber(row.capacityUsd, capacity.medianWeeklyCapacityUsd)
        && closeNumber(
          row.expectedPercentagePoints,
          100 * row.numeratorUsd / row.capacityUsd
        );
    });
  const selectedComparison = comparisonSelectedScenario === null
    ? null
    : comparisonScenarios[comparisonSelectedScenario];
  const comparisonExpectedValues = comparisonStatus === "complete"
    ? [selectedComparison?.expectedPercentagePoints].filter(Number.isFinite)
    : Object.values(comparisonScenarios)
      .filter((row) => row !== null)
      .map((row) => row.expectedPercentagePoints);
  const derivedExpectedLower = comparisonExpectedValues.length > 0
    ? Math.min(...comparisonExpectedValues)
    : null;
  const derivedExpectedUpper = comparisonExpectedValues.length > 0
    ? Math.max(...comparisonExpectedValues)
    : null;
  const sensitivityRows = ALLOWANCE_SCENARIOS.flatMap((scenario) => {
    const row = comparisonScenarios[scenario];
    return row === null ? [] : [{
      numeratorUsd: row.numeratorUsd,
      range: capacityScenarios[scenario].plausibleWeeklyCapacityRangeUsd
    }];
  });
  const derivedSensitivityLower = sensitivityRows.length === 0
    ? null
    : Math.min(...sensitivityRows.map((row) => Math.max(0, (
      minimumMovement * row.range.lower / 100 - row.numeratorUsd
    ) / fastMultiplier)));
  const derivedSensitivityUpper = sensitivityRows.length === 0
    ? null
    : Math.max(...sensitivityRows.map((row) => Math.max(0, (
      maximumMovement * row.range.upper / 100 - row.numeratorUsd
    ) / fastMultiplier)));
  const derivedImpliedMissingWeighted = selectedComparison === null
    ? null
    : Math.max(0, (
      minimumMovement * selectedComparison.capacityUsd / 100
        - selectedComparison.numeratorUsd
    ));
  if (value?.schemaVersion !== SIDE_CHAT_HISTORICAL_GAP_SCHEMA_VERSION
      || date === null || value?.timeZone !== "America/New_York"
      || startAt === null || endAt === null
      || ![23, 24, 25].includes(durationHours)
      || value?.basis
          !== "quota_residual_backcast_not_observed_side_chat_usage"
      || quota?.limitId !== "codex" || quota?.slot !== "primary"
      || count(quota?.durationMinutes, null) !== 10_080
      || resetAt === null
      || quotaRows.some((row) => row.observedAt === null
        || row.usedPercent === null
        || row.usedPercent < 0 || row.usedPercent > 100)
      || quotaTimes.some((time) => !Number.isFinite(time))
      || !(quotaTimes[0] <= startMs
        && startMs <= quotaTimes[1]
        && quotaTimes[1] <= quotaTimes[2]
        && quotaTimes[2] <= endMs
        && endMs <= quotaTimes[3])
      || minimumMovement === null || maximumMovement === null
      || minimumMovement < 0 || maximumMovement < minimumMovement
      || !closeNumber(
        minimumMovement,
        quotaRows[2].usedPercent - quotaRows[1].usedPercent
      )
      || !closeNumber(
        maximumMovement,
        quotaRows[3].usedPercent - quotaRows[0].usedPercent
      )
      || quota?.observationPrecision !== "whole_percentage_points"
      || [events, sessions, totalTokens, standardCost, weightedLower,
        weightedUpper, pricedEvents, unpricedEvents, unsupportedEvents,
        unknownSpeedEvents].includes(null)
      || allowanceWeighting === null
      || events < 1 || sessions < 1 || totalTokens < 1
      || weightedScenarioValues.length < 1
      || !closeNumber(weightedLower, Math.min(...weightedScenarioValues))
      || !closeNumber(weightedUpper, Math.max(...weightedScenarioValues))
      || weightedLower < standardCost || weightedUpper < weightedLower
      || observedModels.length !== 1
      || speedKeys.some((speed) => Object.values(bySpeed[speed]).includes(null))
      || speedEvents !== events || speedTokens !== totalTokens
      || !closeNumber(speedCost, standardCost)
      || pricedEvents !== events || unpricedEvents !== 0
      || unsupportedEvents !== 0
      || unknownSpeedEvents !== bySpeed.unknown.events
      || typeof calibration?.sourceCacheSchemaVersion !== "string"
      || !/^local-replay-safe-accounting-v0\.\d+$/u.test(
        calibration.sourceCacheSchemaVersion
      )
      || !["current_schema", "validated_newer_schema_subdocument"].includes(
        calibration?.sourceCacheRelationship
      )
      || calibration?.weeklyCalibrationSchemaVersion
          !== "weekly-calibration-summary-v0.1"
      || calibration?.basisFamilyId !== ALLOWANCE_BASIS_FAMILY_ID
      || calibration?.accountAttribution
          !== "historical_unattributed_may_combine_accounts"
      || ALLOWANCE_SCENARIOS.some((scenario) => {
        const row = capacityScenarios[scenario];
        const lower = row.plausibleWeeklyCapacityRangeUsd.lower;
        const upper = row.plausibleWeeklyCapacityRangeUsd.upper;
        return row.basisId !== allowanceBasisId(scenario)
          || row.generatedAt === null
          || row.selectedCostBasis !== (scenario === "unresolved_as_fast"
            ? "speed_upper"
            : "speed_lower")
          || row.medianWeeklyCapacityUsd === null
          || row.medianWeeklyCapacityUsd <= 0
          || lower === null || lower <= 0
          || upper === null || upper < row.medianWeeklyCapacityUsd
          || lower > row.medianWeeklyCapacityUsd
          || row.qualifyingResets === null || row.qualifyingResets < 1;
      })
      || standardCapacity.qualifyingResets !== fastCapacity.qualifyingResets
      || standardCapacity.cohortId === null
      || standardCapacity.cohortId !== fastCapacity.cohortId
      || calibration?.timelineCapacityEligible !== true
      || estimate?.assumedMissingSpeed !== "fast"
      || assumedMissingModel === null
      || assumedMissingModel !== observedModels[0]
      || estimate?.modelAssumption !== "only_exact_model_observed_that_day"
      || fastMultiplier !== FAST_MODE_ASSUMED_MULTIPLIER
      || estimate?.fastQuotaMultiplierSource !== "assumed_missing_event_context"
      || comparison?.basisFamilyId !== ALLOWANCE_BASIS_FAMILY_ID
      || comparisonStatus === null
      || comparisonStatus !== allowanceWeighting.status
      || !comparisonScenariosValid
      || derivedExpectedLower === null || derivedExpectedUpper === null
      || [expectedLower, expectedUpper, unexplainedLower, unexplainedUpper,
        sensitivityLower, sensitivityUpper, weightedSensitivityLower,
        weightedSensitivityUpper].includes(null)
      || expectedUpper < expectedLower
      || unexplainedUpper < unexplainedLower
      || sensitivityUpper < sensitivityLower
      || !closeNumber(expectedLower, derivedExpectedLower)
      || !closeNumber(expectedUpper, derivedExpectedUpper)
      || !closeNumber(unexplainedLower, minimumMovement - expectedUpper)
      || !closeNumber(unexplainedUpper, maximumMovement - expectedLower)
      || !closeNumber(sensitivityLower, derivedSensitivityLower)
      || !closeNumber(sensitivityUpper, derivedSensitivityUpper)
      || !closeNumber(
        weightedSensitivityLower,
        sensitivityLower * fastMultiplier
      )
      || !closeNumber(
        weightedSensitivityUpper,
        sensitivityUpper * fastMultiplier
      )
      || (comparisonStatus === "complete"
        ? comparisonSelectedScenario !== allowanceWeighting.selectedScenario
          || selectedComparison === null
          || !closeNumber(
            comparisonSelectedExpected,
            selectedComparison.expectedPercentagePoints
          )
          || comparison?.expectedRangePercentagePoints !== null
          || impliedMissing === null || impliedMissingWeighted === null
          || !closeNumber(
            impliedMissingWeighted,
            derivedImpliedMissingWeighted
          )
          || !closeNumber(
            impliedMissing,
            derivedImpliedMissingWeighted / fastMultiplier
          )
        : comparisonSelectedScenario !== null
          || comparisonSelectedExpected !== null
          || comparisonRangeLower === null || comparisonRangeUpper === null
          || !closeNumber(comparisonRangeLower, derivedExpectedLower)
          || !closeNumber(comparisonRangeUpper, derivedExpectedUpper)
          || impliedMissing !== null || impliedMissingWeighted !== null)
      || estimate?.includedInExactUsage !== false
      || estimate?.includedInCalibrationTimeline !== false
      || estimate?.independentlyObserved !== false) {
    return unavailableSideChatHistoricalGap("evidence_invalid");
  }
  return {
    status: "available",
    errorCode: null,
    date,
    timeZone: "America/New_York",
    startAt,
    endAt,
    basis: "quota_residual_backcast_not_observed_side_chat_usage",
    quota: {
      limitId: "codex",
      slot: "primary",
      durationMinutes: 10_080,
      resetAt,
      startBefore: quotaRows[0],
      startAfter: quotaRows[1],
      endBefore: quotaRows[2],
      endAfter: quotaRows[3],
      minimumMovementPercentagePoints: minimumMovement,
      maximumMovementPercentagePoints: maximumMovement,
      observationPrecision: "whole_percentage_points"
    },
    exactUsage: {
      events,
      sessions,
      totalTokens,
      observedModels,
      standardApiPriceEquivalentUsd: standardCost,
      allowanceWeighting,
      quotaWeightedApiPriceEquivalentRangeUsd: {
        lower: weightedLower,
        upper: weightedUpper
      },
      pricingCoverage: { pricedEvents, unpricedEvents: 0 },
      speedWeightingCoverage: {
        unsupportedEvents: 0,
        unknownSpeedEvents
      },
      bySpeed
    },
    calibration: {
      sourceCacheSchemaVersion: calibration.sourceCacheSchemaVersion,
      sourceCacheRelationship: calibration.sourceCacheRelationship,
      weeklyCalibrationSchemaVersion: "weekly-calibration-summary-v0.1",
      basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
      accountAttribution: "historical_unattributed_may_combine_accounts",
      scenarios: capacityScenarios,
      timelineCapacityEligible: true
    },
    estimate: {
      assumedMissingSpeed: "fast",
      assumedMissingModel,
      modelAssumption: "only_exact_model_observed_that_day",
      fastQuotaMultiplier: fastMultiplier,
      fastQuotaMultiplierSource: "assumed_missing_event_context",
      allowanceComparison: {
        status: comparisonStatus,
        basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
        selectedScenario: comparisonSelectedScenario,
        selectedExpectedPercentagePoints: comparisonSelectedExpected,
        scenarios: comparisonScenarios,
        expectedRangePercentagePoints: comparisonStatus === "range"
          ? {
            lower: comparisonRangeLower,
            upper: comparisonRangeUpper
          }
          : null
      },
      exactCostImpliedMedianRangePercentagePoints: {
        lower: expectedLower,
        upper: expectedUpper
      },
      unexplainedMedianRangePercentagePoints: {
        lower: unexplainedLower,
        upper: unexplainedUpper
      },
      impliedMissingStandardApiEquivalentUsd: impliedMissing,
      impliedMissingQuotaWeightedApiEquivalentUsd: impliedMissingWeighted,
      sensitivityRangeUsd: {
        lower: sensitivityLower,
        upper: sensitivityUpper
      },
      quotaWeightedSensitivityRangeUsd: {
        lower: weightedSensitivityLower,
        upper: weightedSensitivityUpper
      },
      includedInExactUsage: false,
      includedInCalibrationTimeline: false,
      independentlyObserved: false
    }
  };
}

function unavailableSideChatEstimates(errorCode = null) {
  return {
    status: "unavailable",
    errorCode: typeof errorCode === "string" && CACHE_SWITCH_SAFE_CODE.test(errorCode)
      ? errorCode
      : null,
    generatedAt: "",
    methodology: null,
    coverage: null,
    periods: [],
    recent: [],
    recentDetailLimit: SIDE_CHAT_RECENT_LIMIT,
    recentTruncated: false,
    historicalGapProbe: unavailableSideChatHistoricalGap()
  };
}

function normalizeSideChatPeriod(value) {
  if (!SIDE_CHAT_PERIOD_IDS.has(value?.periodId)) return null;
  const detectedSessions = count(value.detectedSessions, null);
  const retainedSessions = count(value.retainedSessions, null);
  const visibleTurns = count(value.visibleTurns, null);
  const samplingCalls = count(value.samplingCalls, null);
  const activeContextTokens = count(value.activeContextTokens, null);
  const postCompactionCalls = count(value.postCompactionCalls, null);
  const pricedCalls = count(value.pricedCalls, null);
  const unpricedCalls = count(value.unpricedCalls, null);
  const point = value.estimatedApiPriceEquivalentUsd === null
    ? null
    : nonNegative(value.estimatedApiPriceEquivalentUsd, null);
  const range = point === null ? null : sideChatRange(value.estimatedRangeUsd, point);
  if ([
    detectedSessions,
    retainedSessions,
    visibleTurns,
    samplingCalls,
    activeContextTokens,
    postCompactionCalls,
    pricedCalls,
    unpricedCalls
  ].includes(null)
      || postCompactionCalls > samplingCalls
      || pricedCalls + unpricedCalls !== samplingCalls
      || (unpricedCalls > 0 && (point !== null || value.estimatedRangeUsd !== null))
      || (unpricedCalls === 0 && (point === null || range === null))) return null;
  const startAt = value.startAt === null ? null : canonicalInstant(value.startAt);
  const endAt = canonicalInstant(value.endAt);
  if ((value.periodId !== "all" && startAt === null) || endAt === null) return null;
  return {
    status: "available",
    periodId: value.periodId,
    periodLabel: text(value.periodLabel, "Recorded period"),
    startAt,
    endAt,
    detectedSessions,
    retainedSessions,
    visibleTurns,
    samplingCalls,
    activeContextTokens,
    postCompactionCalls,
    pricedCalls,
    unpricedCalls,
    estimatedApiPriceEquivalentUsd: point,
    estimatedRangeUsd: range
  };
}

function normalizeSideChatRecent(rows) {
  return array(rows).slice(0, SIDE_CHAT_RECENT_LIMIT * 2).flatMap((row) => {
    const observedAt = canonicalInstant(row?.observedAt);
    const model = LOCAL_MODELS.has(row?.model) ? row.model : null;
    const reasoningEffort = LOCAL_REASONING_EFFORTS.has(row?.reasoningEffort)
      ? row.reasoningEffort
      : null;
    const turnOrdinal = count(row?.turnOrdinal, null);
    const activeContextTokens = count(row?.activeContextTokens, null);
    const cacheAssumption = SIDE_CHAT_CACHE_ASSUMPTIONS.has(row?.cacheAssumption)
      ? row.cacheAssumption
      : null;
    const point = row?.estimatedApiPriceEquivalentUsd === null
      ? null
      : nonNegative(row?.estimatedApiPriceEquivalentUsd, null);
    const range = point === null ? null : sideChatRange(row?.estimatedRangeUsd, point);
    const compactionBefore = row?.compactionBefore === true;
    const pricingBasis = SIDE_CHAT_PRICING_BASES.has(row?.pricingBasis)
      ? row.pricingBasis
      : null;
    if (observedAt === null || model === null || reasoningEffort === null
        || turnOrdinal === null || turnOrdinal < 1
        || activeContextTokens === null || activeContextTokens === 0
        || cacheAssumption === null
        || (point === null) !== (row?.estimatedRangeUsd === null)
        || (point !== null && range === null)
        || pricingBasis === null
        || (point === null) !== (pricingBasis === "unavailable")
        || (point !== null
          && (pricingBasis === "reviewed_alias_assumption")
            !== SIDE_CHAT_CONDITIONAL_ALIAS_MODELS.has(model))
        || compactionBefore !== (cacheAssumption === "cold_after_compaction")) {
      return [];
    }
    // Explicit privacy projection: identifiers and source/log fields never
    // survive a hostile local payload into the rendered dashboard.
    return [{
      observedAt,
      model,
      reasoningEffort,
      turnOrdinal,
      activeContextTokens,
      cacheAssumption,
      compactionBefore,
      estimatedApiPriceEquivalentUsd: point,
      estimatedRangeUsd: range,
      pricingBasis
    }];
  }).sort(
    (left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt)
  ).slice(0, SIDE_CHAT_RECENT_LIMIT);
}

function normalizeSideChatEstimates(value) {
  const historicalGapProbe = normalizeSideChatHistoricalGap(
    value?.historicalGapProbe
  );
  if (value?.status !== "available") {
    return {
      ...unavailableSideChatEstimates(value?.errorCode),
      historicalGapProbe
    };
  }
  if (value.schemaVersion !== SIDE_CHAT_ESTIMATE_SCHEMA_VERSION
      || value?.methodology?.parserVersion !== SIDE_CHAT_ESTIMATE_PARSER_VERSION
      || value?.methodology?.ordinaryAssumption !== "warm_prefix"
      || value?.methodology?.postCompactionAssumption !== "cold_first_request"
      || value?.methodology?.elapsedRetentionAssumption
          !== "warm_to_cold_sensitivity"
      || value?.methodology?.coldUpperInputTreatment
          !== "cache_write_when_reviewed_else_uncached"
      || value?.methodology?.parentCacheStateObserved !== false
      || value?.methodology?.compactionCostIncluded !== false
      || value?.methodology?.componentEvidence
          !== "reconstructed_from_active_context"
      || value?.methodology?.retentionScope
          !== "active_logs2_approximately_ten_days"
      || count(value?.methodology?.approximateRetentionDays, null) !== 10
      || value?.methodology?.includedInExactUsage !== false
      || typeof value?.methodology?.includedInCalibrationTimeline !== "boolean"
      || !SIDE_CHAT_CALIBRATION_STATUSES.has(
        value?.methodology?.calibrationStatus
      )
      || value.methodology.includedInCalibrationTimeline
          !== (value.methodology.calibrationStatus
            === "eligible_active_retention")
      || value?.methodology?.calibrationCohort?.model !== "gpt-5.6-sol"
      || !Array.isArray(value?.methodology?.calibrationCohort?.reasoningEfforts)
      || value.methodology.calibrationCohort.reasoningEfforts.join("|")
          !== "high|max|ultra"
      || count(
        value?.methodology?.calibrationCohort?.matchedDurableCalls,
        null
      ) !== 818
      || canonicalInstant(
        value?.methodology?.calibrationCohort?.calibratedAt
      ) !== "2026-08-17T02:20:00.000Z"
      || count(
        value?.methodology?.calibrationCohort?.freshForSeconds,
        null
      ) !== 2_592_000
      || count(
        value?.methodology?.calibrationCohort?.maximumActiveContextTokens,
        null
      ) !== 271_999
      || !sideChatAssumptionsMatch(value?.methodology?.assumptions)
      || count(value.recentDetailLimit, null) !== SIDE_CHAT_RECENT_LIMIT
      || typeof value.recentTruncated !== "boolean") {
    return {
      ...unavailableSideChatEstimates("methodology_mismatch"),
      historicalGapProbe
    };
  }
  const generatedAt = canonicalInstant(value.generatedAt);
  const desktopStartAt = canonicalInstant(value?.coverage?.desktop?.startAt);
  const desktopEndAt = canonicalInstant(value?.coverage?.desktop?.endAt);
  const desktopOversizedLinesSkipped = count(
    value?.coverage?.desktop?.oversizedLinesSkipped,
    null
  );
  const logs2StartAt = canonicalInstant(value?.coverage?.logs2?.startAt);
  const logs2EndAt = canonicalInstant(value?.coverage?.logs2?.endAt);
  const logs2SourceScope = value?.coverage?.logs2?.sourceScope;
  const detectedSessions = count(value?.coverage?.detectedSessions, null);
  const retainedNumericSessions = count(
    value?.coverage?.retainedNumericSessions,
    null
  );
  const completeNumericSessions = count(
    value?.coverage?.completeNumericSessions,
    null
  );
  const sessionsAtRetentionLimit = count(
    value?.coverage?.sessionsAtRetentionLimit,
    null
  );
  const sessionsWithoutNumericEvidence = count(
    value?.coverage?.sessionsWithoutNumericEvidence,
    null
  );
  const coverageStatus = value?.coverage?.status;
  const duplicateSamplingMarkers = count(
    value?.coverage?.duplicateSamplingMarkers,
    null
  );
  const ambiguousDuplicateMarkers = count(
    value?.coverage?.ambiguousDuplicateMarkers,
    null
  );
  const rejectedSamplingMarkers = count(
    value?.coverage?.rejectedSamplingMarkers,
    null
  );
  const compactionMarkers = count(
    value?.coverage?.compactionMarkers,
    null
  );
  const rejectedCompactionMarkers = count(
    value?.coverage?.rejectedCompactionMarkers,
    null
  );
  const periods = array(value.periods).slice(0, 4)
    .map(normalizeSideChatPeriod);
  const completeCoverage = completeNumericSessions === detectedSessions
    && sessionsAtRetentionLimit === 0
    && sessionsWithoutNumericEvidence === 0
    && desktopOversizedLinesSkipped === 0
    && rejectedSamplingMarkers === 0
    && rejectedCompactionMarkers === 0
    && ambiguousDuplicateMarkers === 0;
  const logs2RangeValid = logs2StartAt !== null && logs2EndAt !== null
    || logs2StartAt === null && logs2EndAt === null
      && (
        detectedSessions === 0
        || coverageStatus === "partial_diagnostic_retention"
          && retainedNumericSessions === 0
          && sessionsWithoutNumericEvidence === detectedSessions
      );
  if (generatedAt === null || desktopStartAt === null || desktopEndAt === null
      || !logs2RangeValid
      || logs2SourceScope !== "active_logs2_retention_only"
      || desktopOversizedLinesSkipped === null
      || detectedSessions === null || retainedNumericSessions === null
      || completeNumericSessions === null
      || sessionsAtRetentionLimit === null
      || sessionsWithoutNumericEvidence === null
      || duplicateSamplingMarkers === null
      || ambiguousDuplicateMarkers === null
      || rejectedSamplingMarkers === null
      || rejectedCompactionMarkers === null
      || compactionMarkers === null
      || retainedNumericSessions + sessionsWithoutNumericEvidence !== detectedSessions
      || completeNumericSessions + sessionsAtRetentionLimit
          !== retainedNumericSessions
      || !new Set([
        "retained_for_all_detected_sessions",
        "partial_diagnostic_retention"
      ]).has(coverageStatus)
      || (coverageStatus === "retained_for_all_detected_sessions")
          !== completeCoverage
      || periods.length !== 4 || periods.includes(null)
      || new Set(periods.map((period) => period.periodId)).size !== 4) {
    return {
      ...unavailableSideChatEstimates("evidence_invalid"),
      historicalGapProbe
    };
  }
  return {
    status: "available",
    errorCode: null,
    generatedAt,
    methodology: {
      parserVersion: SIDE_CHAT_ESTIMATE_PARSER_VERSION,
      ordinaryAssumption: "warm_prefix",
      postCompactionAssumption: "cold_first_request",
      elapsedRetentionAssumption: "warm_to_cold_sensitivity",
      coldUpperInputTreatment: "cache_write_when_reviewed_else_uncached",
      parentCacheStateObserved: false,
      compactionCostIncluded: false,
      componentEvidence: "reconstructed_from_active_context",
      retentionScope: "active_logs2_approximately_ten_days",
      approximateRetentionDays: 10,
      includedInExactUsage: false,
      includedInCalibrationTimeline:
        value.methodology.includedInCalibrationTimeline,
      calibrationStatus: value.methodology.calibrationStatus,
      calibrationCohort: {
        model: "gpt-5.6-sol",
        reasoningEfforts: ["high", "max", "ultra"],
        matchedDurableCalls: 818,
        calibratedAt: "2026-08-17T02:20:00.000Z",
        freshForSeconds: 2_592_000,
        maximumActiveContextTokens: 271_999
      },
      assumptions: SIDE_CHAT_ASSUMPTIONS
    },
    coverage: {
      desktop: {
        filesScanned: count(value?.coverage?.desktop?.filesScanned, 0),
        bytesScanned: count(value?.coverage?.desktop?.bytesScanned, 0),
        oversizedLinesSkipped: desktopOversizedLinesSkipped,
        startAt: desktopStartAt,
        endAt: desktopEndAt
      },
      logs2: {
        startAt: logs2StartAt,
        endAt: logs2EndAt,
        sourceScope: "active_logs2_retention_only"
      },
      detectedSessions,
      retainedNumericSessions,
      completeNumericSessions,
      sessionsAtRetentionLimit,
      sessionsWithoutNumericEvidence,
      duplicateSamplingMarkers,
      ambiguousDuplicateMarkers,
      rejectedSamplingMarkers,
      rejectedCompactionMarkers,
      compactionMarkers,
      status: coverageStatus
    },
    periods,
    recent: normalizeSideChatRecent(value.recent),
    recentDetailLimit: SIDE_CHAT_RECENT_LIMIT,
    recentTruncated: value.recentTruncated,
    historicalGapProbe
  };
}

// The labeled prior-version cost figures served while no current accounting
// source exists. Bounded to the per-period headline scalars plus the
// staleness provenance; anything else the old artifact carried stays behind.
function normalizeStaleAccountingServe(value) {
  const provenance = normalizeStaleProvenance(value);
  if (provenance === null) return null;
  const periods = array(value.periods).flatMap((period) => (
    ["24h", "7d", "30d", "all"].includes(period?.periodId)
      && typeof period.periodLabel === "string"
      && period.periodLabel.length > 0
      ? [{
        periodId: period.periodId,
        periodLabel: period.periodLabel,
        events: count(period.events, 0),
        totalTokens: count(period.totalTokens, 0),
        apiPriceEquivalentUsd: nonNegative(period.apiPriceEquivalentUsd, 0)
      }]
      : []
  )).slice(0, 5);
  if (periods.length === 0) return null;
  return { ...provenance, periods };
}

function normalizeLocalAccounting(value = {}, {
  allowImplicitDemoProjection = false
} = {}) {
  const models = normalizeLocalModelUsage(value.byModel);
  // Both allowance tracks in one list, each row stating which track it belongs
  // to. The local report already publishes this; dropping it here is what left
  // the separately metered Spark allowance invisible on the model table.
  const modelUsage = Array.isArray(value.modelUsage)
    ? normalizeLocalModelUsage(value.modelUsage)
    : [...models, ...normalizeLocalModelUsage(value?.spark?.byModel)];
  const normalized = {
    generation: normalizeAccountingGeneration(value.generation),
    generationMatched: value.generationMatched === true,
    projection: normalizeAccountingProjection(value.projection, {
      allowImplicitDemoProjection
    }),
    periodId: ["24h", "7d", "30d", "all", "history"].includes(value.periodId)
      ? value.periodId
      : "all",
    periodLabel: text(value.periodLabel, "Recorded period"),
    events: count(value.events, 0),
    totalTokens: count(value.totalTokens, 0),
    apiPriceEquivalentUsd: nonNegative(value.apiPriceEquivalentUsd, 0),
    priceCardIds: array(value.priceCardIds)
      .filter((id) => typeof id === "string" && id.length > 0)
      .slice(0, 32),
    priceCardBreakdown: array(value.priceCardBreakdown)
      .flatMap((item) => (
        typeof item?.priceCardId === "string"
          && Number.isSafeInteger(item.events)
          && item.events >= 0
          && typeof item.costUsd === "string"
          && /^\d+(?:\.\d+)?$/u.test(item.costUsd)
          ? [{ priceCardId: item.priceCardId, events: item.events, costUsd: item.costUsd }]
          : []
      ))
      .slice(0, 32),
    quotaWeightedApiPriceEquivalentUsd: nonNegative(
      value.quotaWeightedApiPriceEquivalentUsd,
      null
    ),
    fastMode: normalizeFastMode(value.fastMode),
    speedWeighting: normalizeSpeedWeighting(value.speedWeighting),
    pricingCoverage: {
      fullyPricedEvents: count(value?.pricingCoverage?.fullyPricedEvents, 0),
      partiallyPricedEvents: count(value?.pricingCoverage?.partiallyPricedEvents, 0),
      unpricedEvents: count(value?.pricingCoverage?.unpricedEvents, 0)
    },
    components: normalizeLocalComponents(value.components),
    componentCosts: normalizeLocalComponentCosts(value.componentCosts),
    cacheSwitchImpact: normalizeCacheSwitchImpact(value.cacheSwitchImpact),
    cacheContinuityImpact: normalizeCacheContinuityImpact(
      value.cacheContinuityImpact
    ),
    sideChatEstimates: normalizeSideChatEstimates(value.sideChatEstimates),
    byModel: models,
    modelUsage,
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
    toolClasses: value?.toolClasses?.status === "unavailable"
      ? {
        status: "unavailable",
        reason: value.toolClasses.reason === "typed_tool_history_partial"
          ? "typed_tool_history_partial"
          : "unified_usage_projection_unavailable",
        total: null,
        counts: Object.fromEntries(
          ["apply_patch", "local_shell", "other", "subagent", "tool_gateway"]
            .map((key) => [key, null])
        )
      }
      : {
        status: "available",
        reason: null,
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
    staleServe: normalizeStaleAccountingServe(value.staleServe),
    historyCoverage: normalizeHistoryCoverage(value.historyCoverage),
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
    evidenceStartDate: typeof value.evidenceStartDate === "string"
      && /^\d{4}-\d{2}-\d{2}$/u.test(value.evidenceStartDate)
      ? value.evidenceStartDate
      : null,
    generatedAt: text(value.generatedAt, ""),
    coveredAt: {
      startAt: text(value?.coveredAt?.startAt, ""),
      endAt: text(value?.coveredAt?.endAt, "")
    },
    unknownModelEvents: count(value.unknownModelEvents, 0),
    periods: []
  };
  normalized.periods = array(value.periods).slice(0, 5).map((period) => (
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
  const durationCandidate = finite(window?.durationMinutes ?? window?.duration_minutes ?? window?.windowMinutes, null);
  const durationMinutes = isValidQuotaWindowDuration(durationCandidate)
    ? durationCandidate
    : null;
  const limitId = normalizeQuotaLimitId(window?.limitId);
  const limitName = sanitizeQuotaLimitDisplayName(
    window?.limitName ?? window?.limit_name,
  );
  return {
    id: text(window?.id ?? limitId, `quota-${index}`),
    limitId,
    slot: text(window?.slot, "unknown"),
    // Labels are fixed product copy. The raw label can be localized or
    // provider-controlled, so it is never used to name or select a window.
    label: quotaWindowLabel(limitId, durationMinutes, limitName),
    limitName,
    durationMinutes,
    usedPercent: used,
    remainingPercent: remaining,
    resetAt: text(window?.resetAt ?? window?.reset_at, ""),
    observedAt: text(window?.observedAt ?? window?.observed_at, ""),
    precision: finite(window?.precision ?? window?.displayPrecision, null),
    planType: normalizePlanType(window?.planType ?? window?.plan_type),
    accountAttribution: text(window?.accountAttribution, ""),
    status: safeState(window?.status, "live")
  };
}

function normalizeHistoryCoverage(value = {}) {
  const admittedPhase = [
    "complete",
    "idle",
    "awaiting_resume",
    "not_started",
    "invalid",
  ].includes(value?.phase)
    ? value.phase
    : "not_started";
  const sourceCount = count(value?.sourceCount, null);
  const indexedSourceCount = count(value?.indexedSourceCount, null);
  const pendingSourceCount = count(value?.pendingSourceCount, null);
  const skippedSourceCount = count(value?.skippedSourceCount, null);
  const skippedThreadCount = count(value?.skippedThreadCount, null);
  const sourceBytes = count(value?.sourceBytes, null);
  const indexedBytes = count(value?.indexedBytes, null);
  const skippedSourceBytes = count(value?.skippedSourceBytes, null);
  const generatedAt = canonicalInstant(value?.generatedAt);
  const coveredStartAt = canonicalInstant(value?.coveredAt?.startAt);
  const coveredEndAt = canonicalInstant(value?.coveredAt?.endAt);
  const errorCode = [
    "archive_directory_entries",
    "archive_rollout_files",
    "archive_timeout",
    "archive_interrupted",
    "archive_disk_space",
    "archive_storage_unavailable",
    "archive_index_unavailable",
    "local_unified_index_generation_invalid",
    "local_unified_index_missing",
    "local_unified_index_schema_invalid",
    "local_unified_index_schema_newer",
    "local_unified_index_unavailable",
  ].includes(value?.errorCode)
    ? value.errorCode
    : null;
  // `partial_terminal` is the one non-progress state whose missing sources
  // remain intentionally visible. Admit it only with a coherent quarantine
  // receipt: otherwise an arbitrary partial payload could turn off automatic
  // refreshes or manufacture a skipped-source explanation in the browser.
  const terminalGap = value?.status === "partial"
    && value?.phase === "partial_terminal"
    && errorCode === null
    && sourceCount !== null
    && sourceCount > 0
    && indexedSourceCount !== null
    && pendingSourceCount === 0
    && skippedSourceCount !== null
    && skippedSourceCount > 0
    && indexedSourceCount + skippedSourceCount === sourceCount
    && skippedThreadCount !== null
    && skippedThreadCount > 0
    && skippedThreadCount <= skippedSourceCount
    && sourceBytes !== null
    && indexedBytes !== null
    && skippedSourceBytes !== null
    && indexedBytes + skippedSourceBytes === sourceBytes;
  const phase = terminalGap ? "partial_terminal" : admittedPhase;
  const coherent = sourceCount !== null
    && indexedSourceCount !== null
    && pendingSourceCount !== null
    && indexedSourceCount + pendingSourceCount === sourceCount
    && sourceBytes !== null
    && indexedBytes !== null
    && indexedBytes <= sourceBytes;
  // “Complete” is a claim about the whole archive, so a malformed or
  // internally inconsistent browser payload must fail closed to partial.
  const complete = value?.status === "complete"
    && ["complete", "idle"].includes(phase)
    && errorCode === null
    && coherent
    && indexedSourceCount === sourceCount
    && pendingSourceCount === 0
    && indexedBytes === sourceBytes
    && generatedAt !== null
    && coveredStartAt !== null
    && coveredEndAt !== null
    && Date.parse(coveredEndAt) >= Date.parse(coveredStartAt);
  return {
    status: complete ? "complete" : "partial",
    phase,
    sourceCount: sourceCount ?? 0,
    indexedSourceCount: sourceCount === null || indexedSourceCount === null
      ? 0
      : Math.min(indexedSourceCount, sourceCount),
    pendingSourceCount: sourceCount === null || pendingSourceCount === null
      ? 0
      : Math.min(pendingSourceCount, sourceCount),
    skippedSourceCount: terminalGap ? skippedSourceCount : 0,
    skippedSourceBytes: terminalGap ? skippedSourceBytes : 0,
    skippedThreadCount: terminalGap ? skippedThreadCount : 0,
    sourceBytes: sourceBytes ?? 0,
    indexedBytes: sourceBytes === null || indexedBytes === null
      ? 0
      : Math.min(indexedBytes, sourceBytes),
    generatedAt: generatedAt ?? "",
    errorCode,
    coveredAt: {
      startAt: coveredStartAt ?? "",
      endAt: coveredEndAt ?? "",
    },
  };
}

function normalizePricing(pricing = {}) {
  const source = pricing?.components ?? pricing?.componentTotals ?? {};
  const priceEpochBasis = text(pricing?.priceEpochBasis, "");
  const componentRows = Array.isArray(source)
    ? source
    : Object.entries(source).map(([name, value]) => ({
        name,
        tokens: value?.tokens ?? value?.tokenCount ?? value,
        costUsd: value?.costUsd ?? value?.estimatedCostUsd
      }));
  return {
    totalCostUsd: finite(pricing?.totalCostUsd ?? pricing?.estimatedApiCostUsd ?? pricing?.total_usd, null),
    quotaWeightedTotalCostUsd: nonNegative(pricing?.quotaWeightedTotalCostUsd, null),
    fastMode: normalizeFastMode(pricing?.fastMode),
    periodLabel: text(pricing?.periodLabel ?? pricing?.label, "Recorded period"),
    coveragePercent: finite(pricing?.coveragePercent ?? pricing?.pricedCoveragePercent ?? pricing?.pricedEventCoveragePercent, null),
    eventCount: finite(pricing?.eventCount ?? pricing?.pricedEventCount, null),
    apiTier: text(pricing?.apiTier ?? pricing?.tier, "standard"),
    basis: text(pricing?.basis, "api_price_equivalent"),
    apiServiceTier: text(pricing?.apiServiceTier, "unknown"),
    subscriptionSpeedIsSeparate: pricing?.subscriptionSpeedIsSeparate === true,
    registryVersion: text(pricing?.registryVersion, ""),
    registryObservedAt: text(pricing?.registryObservedAt, ""),
    evidenceStartDate: typeof pricing?.evidenceStartDate === "string"
      && /^\d{4}-\d{2}-\d{2}$/u.test(pricing.evidenceStartDate)
      ? pricing.evidenceStartDate
      : null,
    priceEpochBasis,
    eventTimeHistoricalTotalUsdExact: typeof pricing?.eventTimeHistoricalTotalUsdExact === "string"
      && /^\d+(?:\.\d+)?$/u.test(pricing.eventTimeHistoricalTotalUsdExact)
      ? pricing.eventTimeHistoricalTotalUsdExact
      : null,
    currentPriceSensitivityTotalUsdExact: priceEpochBasis === "event_time_when_registry_has_effective_evidence"
      ? null
      : typeof pricing?.currentPriceSensitivityTotalUsdExact === "string"
      && /^\d+(?:\.\d+)?$/u.test(pricing.currentPriceSensitivityTotalUsdExact)
      ? pricing.currentPriceSensitivityTotalUsdExact
      : null,
    priceCardIds: array(pricing?.priceCardIds)
      .filter((id) => typeof id === "string" && id.length > 0)
      .slice(0, 32),
    priceCardBreakdown: array(pricing?.priceCardBreakdown)
      .flatMap((item) => (
        typeof item?.priceCardId === "string"
          && Number.isSafeInteger(item.events)
          && item.events >= 0
          && typeof item.costUsd === "string"
          && /^\d+(?:\.\d+)?$/u.test(item.costUsd)
          ? [{ priceCardId: item.priceCardId, events: item.events, costUsd: item.costUsd }]
          : []
      ))
      .slice(0, 32),
    mixedPriceCardWindows: pricing?.mixedPriceCardWindows === true,
    components: componentRows.slice(0, 12).map((row) => ({
      name: text(row?.name ?? row?.component, "Unknown"),
      tokens: finite(row?.tokens ?? row?.value, 0),
      costUsd: finite(row?.costUsd, null)
    })),
    accountingSource: text(pricing?.accountingSource, "unknown"),
    accountingCacheStatus: text(pricing?.accountingCacheStatus, "unknown"),
    historyCoverage: normalizeHistoryCoverage(pricing?.historyCoverage),
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

const WEEKLY_PACE_FORECAST_SCHEMA_VERSION = "local-weekly-pace-forecast-v0.2";
const WEEKLY_PACE_FORECAST_STATUSES = new Set([
  "unavailable",
  "insufficient_observations",
  "available",
  "will_reach_reset_first"
]);
const WEEKLY_PACE_FORECAST_METHOD = "median_adjacent_quota_slope";

function weeklyPaceNumber(value, {
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY
} = {}) {
  if (value === null) return null;
  return typeof value === "number"
      && Number.isFinite(value)
      && value >= minimum
      && value <= maximum
    ? value
    : undefined;
}

function normalizeWeeklyPaceForecast(value) {
  const expectedKeys = [
    "schemaVersion",
    "status",
    "currentUsedPercent",
    "remainingPercent",
    "resetsAt",
    "pace",
    "observationCount",
    "etaAt",
    "hoursToExhaustion",
    "hoursToReset"
  ];
  if (!hasExactKeys(value, expectedKeys)
      || value.schemaVersion !== WEEKLY_PACE_FORECAST_SCHEMA_VERSION
      || !WEEKLY_PACE_FORECAST_STATUSES.has(value.status)
      || !hasExactKeys(value.pace, [
        "method",
        "sampleCount",
        "elapsedHours",
        "movementPp",
        "activePercentagePointsPerHour",
        "overallPercentagePointsPerHour"
      ])) return null;
  const currentUsedPercent = weeklyPaceNumber(value.currentUsedPercent, {
    minimum: 0,
    maximum: 100
  });
  const remainingPercent = weeklyPaceNumber(value.remainingPercent, {
    minimum: 0,
    maximum: 100
  });
  const elapsedHours = weeklyPaceNumber(value.pace.elapsedHours, { minimum: 0 });
  const movementPp = weeklyPaceNumber(value.pace.movementPp, { minimum: 0 });
  const activePercentagePointsPerHour = weeklyPaceNumber(
    value.pace.activePercentagePointsPerHour,
    { minimum: 0, maximum: 100 }
  );
  const overallPercentagePointsPerHour = weeklyPaceNumber(
    value.pace.overallPercentagePointsPerHour,
    { minimum: 0, maximum: 100 }
  );
  const hoursToExhaustion = weeklyPaceNumber(value.hoursToExhaustion, {
    minimum: 0
  });
  const hoursToReset = weeklyPaceNumber(value.hoursToReset, { minimum: 0 });
  const resetsAt = value.resetsAt === null ? null : canonicalInstant(value.resetsAt);
  const etaAt = value.etaAt === null ? null : canonicalInstant(value.etaAt);
  if (currentUsedPercent === undefined
      || remainingPercent === undefined
      || elapsedHours === undefined
      || movementPp === undefined
      || activePercentagePointsPerHour === undefined
      || overallPercentagePointsPerHour === undefined
      || hoursToExhaustion === undefined
      || hoursToReset === undefined
      || (value.resetsAt !== null && resetsAt === null)
      || (value.etaAt !== null && etaAt === null)
      || (value.pace.method !== null
        && value.pace.method !== WEEKLY_PACE_FORECAST_METHOD)
      || !Number.isSafeInteger(value.pace.sampleCount)
      || value.pace.sampleCount < 0
      || value.pace.sampleCount >= 8_192
      || !Number.isSafeInteger(value.observationCount)
      || value.observationCount < 0
      || value.observationCount > 8_192) return null;
  if (value.status === "available") {
    if (currentUsedPercent === null
        || remainingPercent === null
        || resetsAt === null
        || etaAt === null
        || overallPercentagePointsPerHour === null
        || overallPercentagePointsPerHour <= 0
        || hoursToExhaustion === null
        || hoursToReset === null
        || Date.parse(etaAt) >= Date.parse(resetsAt)) return null;
  } else if (etaAt !== null || hoursToExhaustion !== null) {
    return null;
  }
  return {
    schemaVersion: WEEKLY_PACE_FORECAST_SCHEMA_VERSION,
    status: value.status,
    currentUsedPercent,
    remainingPercent,
    resetsAt,
    pace: {
      method: value.pace.method,
      sampleCount: value.pace.sampleCount,
      elapsedHours,
      movementPp,
      activePercentagePointsPerHour,
      overallPercentagePointsPerHour
    },
    observationCount: value.observationCount,
    etaAt,
    hoursToExhaustion,
    hoursToReset
  };
}

// The companion owns pace classification and geometry. Retain its newer
// native-menu-bar DTO without recalculating a second forecast in the browser.
function normalizeWeeklyPaceOutlook(value) {
  const approximatelyEqual = (left, right) => Number.isFinite(left)
    && Number.isFinite(right)
    && Math.abs(left - right) <= 0.000_001 * Math.max(1, Math.abs(left), Math.abs(right));
  const rateKeys = ["activePercentagePointsPerHour", "overallPercentagePointsPerHour",
    "headlinePercentagePointsPerHour", "sustainablePercentagePointsPerHour", "ratio"];
  const projectionKeys = ["hoursToReset", "coveredHours", "dryHours", "sparePercent", "projectedExhaustionAt"];
  const trackKeys = ["coveredFraction", "activeExhaustionFraction"];
  if (!hasExactKeys(value, ["schemaVersion", "status", "standing", "critical", "earlyEstimate",
    "remainingPercent", "resetsAt", "observationCount", "elapsedHours", "rates", "projection", "track"])
      || value.schemaVersion !== "local-weekly-pace-outlook-v0.1"
      || !["unavailable", "collecting", "available"].includes(value.status)
      || typeof value.critical !== "boolean" || typeof value.earlyEstimate !== "boolean"
      || !Number.isSafeInteger(value.observationCount)
      || value.observationCount < 0 || value.observationCount > 8_192
      || !hasExactKeys(value.rates, rateKeys)
      || !hasExactKeys(value.projection, projectionKeys)
      || !hasExactKeys(value.track, trackKeys)) return null;
  const remainingPercent = weeklyPaceNumber(value.remainingPercent, { minimum: 0, maximum: 100 });
  const elapsedHours = weeklyPaceNumber(value.elapsedHours, { minimum: 0 });
  const resetsAt = value.resetsAt === null ? null : canonicalInstant(value.resetsAt);
  const projectedExhaustionAt = value.projection.projectedExhaustionAt === null
    ? null : canonicalInstant(value.projection.projectedExhaustionAt);
  const rates = Object.fromEntries(rateKeys.map((key) => [key, weeklyPaceNumber(value.rates[key], {
    minimum: 0, maximum: key === "ratio" || key === "sustainablePercentagePointsPerHour" ? Infinity : 100,
  })]));
  const projection = Object.fromEntries(projectionKeys.slice(0, -1).map((key) => [key,
    weeklyPaceNumber(value.projection[key], { minimum: 0, maximum: key === "sparePercent" ? 100 : Infinity })]));
  projection.projectedExhaustionAt = projectedExhaustionAt;
  const track = Object.fromEntries(trackKeys.map((key) => [key,
    weeklyPaceNumber(value.track[key], { minimum: 0, maximum: 1 })]));
  const numbers = [remainingPercent, elapsedHours, ...Object.values(rates),
    ...Object.values(projection), ...Object.values(track)];
  if (numbers.includes(undefined)
      || (value.resetsAt !== null && resetsAt === null)
      || (value.projection.projectedExhaustionAt !== null && projectedExhaustionAt === null)) return null;
  if (value.status === "unavailable") {
    if (value.standing !== null || value.critical || value.earlyEstimate
        || value.observationCount !== 0 || resetsAt !== null
        || numbers.some((number) => number !== null)) return null;
  } else {
    if (remainingPercent === null || resetsAt === null || elapsedHours === null
        || !(projection.hoursToReset > 0)) return null;
    if (value.status === "collecting") {
      if (value.standing !== null || value.critical || value.earlyEstimate
          || value.observationCount !== 1
          || [...Object.values(rates), ...Object.values(track), projection.coveredHours,
            projection.dryHours, projection.sparePercent, projectedExhaustionAt]
            .some((number) => number !== null)) return null;
    } else {
      if (!["under", "on", "over"].includes(value.standing)
          || value.observationCount < 2 || !(elapsedHours > 0) || !(remainingPercent > 0)
          || !(rates.headlinePercentagePointsPerHour > 0)
          || !(rates.sustainablePercentagePointsPerHour > 0) || !(rates.ratio > 0)
          || (rates.activePercentagePointsPerHour !== null && !(rates.activePercentagePointsPerHour > 0))
          || (rates.overallPercentagePointsPerHour !== null && !(rates.overallPercentagePointsPerHour > 0))
          || !approximatelyEqual(rates.headlinePercentagePointsPerHour,
            rates.overallPercentagePointsPerHour ?? rates.activePercentagePointsPerHour)
          || projection.coveredHours === null || projection.dryHours === null
          || projection.sparePercent === null || track.coveredFraction === null
          || !approximatelyEqual(rates.sustainablePercentagePointsPerHour,
            remainingPercent / projection.hoursToReset)
          || !approximatelyEqual(rates.ratio,
            rates.headlinePercentagePointsPerHour / rates.sustainablePercentagePointsPerHour)
          || !approximatelyEqual(projection.coveredHours + projection.dryHours, projection.hoursToReset)
          || !approximatelyEqual(projection.coveredHours,
            Math.min(projection.hoursToReset, remainingPercent / rates.headlinePercentagePointsPerHour))
          || !approximatelyEqual(projection.sparePercent,
            Math.max(0, remainingPercent - rates.headlinePercentagePointsPerHour * projection.hoursToReset))
          || !approximatelyEqual(track.coveredFraction, projection.coveredHours / projection.hoursToReset)
          || !(value.standing === "under" ? rates.ratio < 0.85
            : value.standing === "on" ? rates.ratio >= 0.85 && rates.ratio <= 1.15 : rates.ratio > 1.15)
          || value.critical !== (value.standing === "over" && rates.ratio >= 2)
          || (value.earlyEstimate && value.observationCount > 2 && elapsedHours >= 1)
          || (value.standing === "over"
            ? projectedExhaustionAt === null || Date.parse(projectedExhaustionAt) >= Date.parse(resetsAt)
            : projectedExhaustionAt !== null)) return null;
      const activeHours = rates.activePercentagePointsPerHour === null
        ? null : remainingPercent / rates.activePercentagePointsPerHour;
      const expectedActiveFraction = activeHours !== null && activeHours < projection.coveredHours * 0.95
        ? Math.max(0, Math.min(1, activeHours / projection.hoursToReset)) : null;
      if (expectedActiveFraction === null
        ? track.activeExhaustionFraction !== null
        : !approximatelyEqual(track.activeExhaustionFraction, expectedActiveFraction)) return null;
      if (value.standing === "over"
          && Math.abs(Date.parse(projectedExhaustionAt)
            - (Date.parse(resetsAt) - projection.dryHours * 3_600_000)) > 10) return null;
    }
  }
  return {
    schemaVersion: value.schemaVersion, status: value.status, standing: value.standing,
    critical: value.critical, earlyEstimate: value.earlyEstimate, remainingPercent,
    resetsAt, observationCount: value.observationCount, elapsedHours, rates, projection, track,
  };
}

function normalizeWeeklyPlanAttribution(value) {
  if (value?.methodVersion !== "plan-era-v1"
      || value?.status !== "historical_plan_conditional"
      || value?.accountVerified !== false) return null;
  return {
    methodVersion: "plan-era-v1",
    status: "historical_plan_conditional",
    accountVerified: false,
    comparisonEligibility: value.comparisonEligibility === "single_plan_conditional"
      ? "single_plan_conditional" : "unavailable",
  };
}

function normalizeWeeklyPopulation(envelope = {}) {
  const source = artifactData(envelope);
  const weeklyValueColumns = new Set([
    "sequence", "first_observed_at", "last_observed_at", "reset_due_at",
    "resetAt", "slot", "displayed_span_pp", "value_usd", "value",
    "pairwise_p10_usd", "pairwise_p90_usd", "lower", "upper",
    "holdout_mae_pp", "known_speed_fraction", "eligible_transitions",
    "unique_percentage_boundaries",
  ]);
  const weeklyValues = array(source.weeklyValues ?? source.weekly_values)
    .map((row) => {
      // A local era key can encode account context. It has no presentation
      // purpose. Carry only the displayed fit columns, never opaque context.
      const columns = Object.fromEntries(Object.entries(row ?? {})
        .filter(([key]) => weeklyValueColumns.has(key)));
      return {
        ...columns,
        planType: normalizePlanType(row?.planType ?? row?.plan_type),
        planVariant: typeof (row?.planVariant ?? row?.plan_variant) === "string"
            && /^[a-z][a-z0-9_-]{0,31}$/u.test(row.planVariant ?? row.plan_variant)
          ? row.planVariant ?? row.plan_variant : "unknown",
        aggregationEligibility: ["primary_conditional", "primary_scoped", "diagnostic_only"]
          .includes(row?.aggregationEligibility ?? row?.aggregation_eligibility)
          ? row.aggregationEligibility ?? row.aggregation_eligibility : null,
        priceCardIds: array(row?.priceCardIds ?? row?.price_card_ids)
          .filter((id) => typeof id === "string" && id.length > 0)
          .slice(0, 32),
        priceCardBreakdown: array(row?.priceCardBreakdown ?? row?.price_card_breakdown)
          .flatMap((item) => {
            if (typeof item?.priceCardId !== "string"
                || !/^\d+(?:\.\d+)?$/u.test(item?.costUsd ?? "")
                || !Number.isSafeInteger(item?.events)
                || item.events < 0) return [];
            return [{
              priceCardId: item.priceCardId,
              events: item.events,
              costUsd: item.costUsd,
            }];
          })
          .slice(0, 32),
      };
    });
  return {
    status: text(envelope?.status, "unavailable"),
    planType: normalizePlanType(envelope?.planType),
    planAttribution: normalizeWeeklyPlanAttribution(envelope?.planAttribution),
    summary: array(source.summary)[0] ?? source.summary ?? {},
    weeklyValues,
    valueSeries: array(source.valueSeries ?? source.value_series),
    holdoutSeries: array(source.holdoutSeries ?? source.holdout_series),
    errorConcentration: array(source.errorConcentration ?? source.error_concentration),
    providerEpochs: array(source.providerEpochs ?? source.provider_epochs),
    dataClass: text(envelope?.dataClass, ""),
    stale: normalizeStaleProvenance(envelope?.stale),
    paceForecast: normalizeWeeklyPaceForecast(envelope?.paceForecast),
    paceOutlook: normalizeWeeklyPaceOutlook(envelope?.paceOutlook),
    accountAttribution: {
      status: text(envelope?.accountAttribution?.status, ""),
      maySpanMultipleAccounts:
        envelope?.accountAttribution?.maySpanMultipleAccounts === true,
      label: text(envelope?.accountAttribution?.label, "")
    }
  };
}

function normalizeWeekly(payload = {}) {
  const envelope = payload?.weekly ?? payload;
  const weekly = normalizeWeeklyPopulation(envelope);
  const planPopulations = [];
  const candidates = array(envelope?.planPopulations).slice(0, 16);
  const planCounts = new Map();
  for (const row of candidates) {
    planCounts.set(row?.planType, (planCounts.get(row?.planType) ?? 0) + 1);
  }
  for (const population of candidates) {
    const planType = population?.planType;
    if (!TELEMETRY_PLAN_TYPES.includes(planType) || planCounts.get(planType) !== 1) continue;
    const normalized = normalizeWeeklyPopulation(population);
    if (normalized.planAttribution === null) continue;
    planPopulations.push({
      ...normalized,
      // The envelope is the selected population, not a license to relabel a
      // positively different plan's historical fit.
      weeklyValues: normalized.weeklyValues.filter((row) => row.planType === planType),
    });
  }
  return {
    ...weekly,
    selectedPlanType: normalizePlanType(envelope?.selectedPlanType ?? envelope?.planType),
    planPopulations,
  };
}

const allowancePlanViews = new WeakMap();
const allowancePlanViewRoots = new WeakMap();

/**
 * One selected population for every allowance-facing surface. Selection never
 * changes the all-plan usage ledger or manufactures historical current pace.
 * The root DTO names the latest observed plan, even when it has no fitted value.
 */
export function selectAllowancePlanPopulation(data, requestedPlanType = null) {
  const root = allowancePlanViewRoots.get(data) ?? data;
  const weekly = root?.weekly;
  if (!weekly || weekly.planAttribution?.methodVersion !== "plan-era-v1") return root;
  const populations = array(weekly.planPopulations);
  const currentPlanType = normalizePlanType(weekly.selectedPlanType ?? weekly.planType);
  const selectedPlanType = populations.some((row) => row.planType === requestedPlanType)
    ? requestedPlanType : currentPlanType;
  let views = allowancePlanViews.get(root);
  if (views?.has(selectedPlanType)) return views.get(selectedPlanType);
  const population = populations.find((row) => row.planType === selectedPlanType)
    ?? normalizeWeeklyPopulation({ planType: selectedPlanType });
  const isCurrentPlan = selectedPlanType === currentPlanType;
  const allowanceCapacity = root.timeline?.allowanceCapacity ?? null;
  const planScoped = root.timeline?.planScoped ?? null;
  // The old gate asked whether the whole retained history contained one plan.
  // That made a perfectly coherent current-plan fit unusable as soon as an
  // earlier plan existed, then paired the selected capacity with all-plan
  // usage anyway. The new gate is stricter where it matters: the scoped usage
  // and fitted capacity must name the same current plan, method, basis, reset
  // cohort and unified-index generation. Historical selections remain
  // unavailable because no historical scoped numerator is published.
  const comparisonAvailable = isCurrentPlan
    && population.status === "available"
    && allowanceCapacity?.status === "available"
    && planScoped?.status === "available"
    && planScoped.planScope?.planType === selectedPlanType
    && matchingPlanScope(
      planScoped.planScope,
      allowanceCapacity.planScope
    );
  const selected = {
    ...root,
    weekly: {
      ...population,
      selectedPlanType: currentPlanType,
      planPopulations: populations,
      stale: weekly.stale,
      paceForecast: isCurrentPlan ? weekly.paceForecast : null,
      paceOutlook: isCurrentPlan ? weekly.paceOutlook : null,
    },
    quotaWindows: isCurrentPlan
      ? array(root.quotaWindows).filter((window) => window.planType === selectedPlanType)
      : [],
    timeline: {
      ...root.timeline,
      // Keep `usage` and `calibrationUsage` as the conserved all-plan ledger.
      // Trends consumes this explicit selected-plan lane; Usage & costs and
      // every all-plan total continue to read the established fields.
      selectedPlanUsage: comparisonAvailable ? planScoped.usage : [],
      selectedPlanCalibrationUsage: comparisonAvailable ? planScoped.usage : [],
      // The scoped quota lane was built before the generic cross-plan collapse.
      // Keep the original root DTO untouched for all-plan consumers.
      quota: comparisonAvailable ? planScoped.quota : [],
      comparisonIntervals: comparisonAvailable ? planScoped.comparisonIntervals : [],
      allowanceCapacity: comparisonAvailable ? allowanceCapacity : null,
    },
    allowancePlanSelection: {
      planType: selectedPlanType,
      currentPlanType,
      isCurrentPlan,
      comparisonAvailable,
    },
  };
  views ??= new Map();
  views.set(selectedPlanType, selected);
  allowancePlanViews.set(root, views);
  allowancePlanViewRoots.set(selected, root);
  return selected;
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
      staleAfterSeconds: finite(freshness?.staleAfterSeconds, null),
      // The companion reports one overall freshness verdict, and a stale
      // cached accounting result makes that verdict "stale" even while the
      // newest collector observation is seconds old. Both parts are published;
      // keeping this one lets the page name what is actually stale instead of
      // telling a reader their observation is old when it is not.
      accountingStatus: text(freshness?.accountingStatus, ""),
      accountingAgeSeconds: finite(freshness?.accountingAgeSeconds, null)
    },
    quotaWindows,
    activity: {
      ...(overview?.activity ?? overview?.live?.activity ?? {}),
      usageEvents: overview?.activity?.usageEvents ?? selectedUsage?.events,
      totalTokens: overview?.activity?.totalTokens ?? selectedUsage?.totalTokens
    },
    usagePeriods: usagePeriods.slice(0, 5).map((period) => ({
      id: ["24h", "7d", "30d", "all", "history"].includes(period?.id) ? period.id : "all",
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
    warnings: array(overview?.warnings)
      .map((warning) => text(warning?.message ?? warning, ""))
      .filter((warning) => warning && warning !== INTERNAL_TOOL_HISTORY_WARNING),
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
    accounting: normalizeLocalAccounting(overview?.accounting, {
      allowImplicitDemoProjection: mode === "demo"
    }),
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
    quality: normalizeQuality(payload?.quality ?? fragments.quality)
  };
}

async function fetchJson(fetchImpl, url, options = {}) {
  const { headers = {}, ...requestOptions } = options;
  const response = await fetchImpl(url, {
    ...requestOptions,
    headers: { Accept: "application/json", ...headers }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = new Error(`Request failed (${response.status}).`);
    error.status = response.status;
    // Keep the fixed, content-free code so the page can say what actually
    // went wrong instead of collapsing every failure into one sentence.
    if (typeof payload?.error?.code === "string"
        && SAFE_ERROR_CODE_PATTERN.test(payload.error.code)) {
      error.code = payload.error.code;
    }
    throw attachServiceRequestId(error, payload);
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
    // Browser-native fetch is receiver-sensitive: invoked as a property of
    // this client it throws "Illegal invocation" (WebKit: "Can only call
    // Window.fetch on instances of Window") before any request leaves the
    // page. Hold a detached wrapper so every method may call
    // this.fetchImpl(...) directly.
    this.fetchImpl = (...args) => fetchImpl(...args);
  }

  async load() {
    const paths = ["overview", "gradient", "weekly", "quality"];
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

  async cacheDropThreadLinks() {
    try {
      return normalizeCacheDropThreadLinks(await fetchJson(
        this.fetchImpl, `${LOCAL_ROOT}/cache-drop-thread-links`, {
          cache: "no-store",
          headers: { "X-Usage-Monitor-Local": "1" }
        }
      ));
    } catch {
      // Older companions and missing optional metadata do not fail refresh.
      return normalizeCacheDropThreadLinks(null);
    }
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
    return fetchJson(this.fetchImpl, `${LOCAL_ROOT}/refresh/quick`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1"
      },
      body: JSON.stringify({})
    });
  }

  async recalculateDetailedAccounting() {
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

  /**
   * The per-model / per-speed cost mix for one bounded [fromMs, toMs] window,
   * repriced from the unified local index by the companion. Used to explain a
   * detected divergence period with its own contributor mix. A companion that
   * predates the route (404/405) reads back as an unavailable breakdown rather
   * than throwing, so the panel degrades to its range-level context.
   */
  async windowBreakdown(fromMs, toMs) {
    if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs)) {
      return normalizeWindowBreakdown(null);
    }
    const query = new URLSearchParams({ from: String(fromMs), to: String(toMs) });
    try {
      return normalizeWindowBreakdown(await fetchJson(
        this.fetchImpl,
        `${LOCAL_ROOT}/timeline/window-breakdown?${query}`,
      ));
    } catch (error) {
      if ([400, 404, 405].includes(error?.status)) {
        return normalizeWindowBreakdown(null);
      }
      throw error;
    }
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

  async contributionDiagnostics() {
    try {
      return normalizeLocalContributionDiagnostics(
        await fetchJson(
          this.fetchImpl,
          `${LOCAL_ROOT}/diagnostics/contribution`
        )
      );
    } catch {
      return normalizeLocalContributionDiagnostics(null);
    }
  }

  async hostedSignInHandoff() {
    try {
      return normalizeHostedSignInHandoff(await fetchJson(
        this.fetchImpl,
        `${LOCAL_ROOT}/identity/hosted-signin-handoff`,
        { headers: { "X-Usage-Monitor-Local": "1" } }
      ));
    } catch {
      return normalizeHostedSignInHandoff(null);
    }
  }

  async storeHostedSignInHandoff({ provider, state, verifier } = {}) {
    if (!["google", "apple"].includes(provider)
        || typeof state !== "string"
        || !HOSTED_SIGNIN_HANDOFF_BOUND_VALUE.test(state)
        || typeof verifier !== "string"
        || !HOSTED_SIGNIN_HANDOFF_BOUND_VALUE.test(verifier)) {
      throw new TypeError("Hosted sign-in handoff is invalid.");
    }
    const payload = await fetchJson(
      this.fetchImpl,
      `${LOCAL_ROOT}/identity/hosted-signin-handoff`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1"
        },
        body: JSON.stringify({ action: "store", provider, state, verifier })
      }
    );
    const normalized = normalizeHostedSignInHandoff(payload);
    if (normalized.status !== "pending") {
      throw new Error("The local companion did not retain the sign-in handoff.");
    }
    return normalized;
  }

  async clearHostedSignInHandoff() {
    const payload = await fetchJson(
      this.fetchImpl,
      `${LOCAL_ROOT}/identity/hosted-signin-handoff`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1"
        },
        body: JSON.stringify({ action: "clear" })
      }
    );
    const normalized = normalizeHostedSignInHandoff(payload);
    if (normalized.status !== "absent") {
      throw new Error("The local companion did not clear the sign-in handoff.");
    }
    return normalized;
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

  /**
   * The bounded status of the approved incremental full-history sync: the
   * durable consent verdict, day-count progress, the paused reason and the
   * last outcome, every code from a fixed vocabulary. A GET with no side
   * effects; a failed read normalizes to the fail-closed unavailable shape.
   */
  async incrementalContributionSyncStatus() {
    try {
      return normalizeIncrementalContributionSyncStatus(
        await fetchJson(
          this.fetchImpl,
          `${LOCAL_ROOT}/contribution/incremental-status`
        )
      );
    } catch {
      return normalizeIncrementalContributionSyncStatus(null);
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
      throw localCompanionRequestError(response, payload);
    }
    return normalizeLocalContributionDevicePairing(payload);
  }

  /**
   * Record one user-visible failure in the local diagnostics log.
   *
   * Only bounded identifiers travel: the reference this page minted, the
   * fixed journey it happened in, the fixed error code, the specific bound
   * behind a coarse code when the failure named one, and the service request
   * id when the service returned one. No message, payload, path, or
   * participant value is ever sent, and the companion re-validates every one.
   */
  async recordDiagnosticNote({
    reference,
    surface,
    code = "",
    detail = "",
    requestId = ""
  } = {}) {
    if (!DIAGNOSTIC_REFERENCE_PATTERN.test(reference ?? "")
        || typeof surface !== "string"
        || !SAFE_ERROR_CODE_PATTERN.test(surface)) {
      throw new TypeError("Diagnostic note inputs are invalid.");
    }
    const detailCode = typeof detail === "string"
        && SAFE_ERROR_CODE_PATTERN.test(detail)
      ? detail
      : null;
    const response = await this.fetchImpl(`${LOCAL_ROOT}/diagnostics/note`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Usage-Monitor-Local": "1"
      },
      body: JSON.stringify({
        reference,
        surface,
        code: SAFE_ERROR_CODE_PATTERN.test(code) ? code : "unknown",
        ...(detailCode === null ? {} : { detail: detailCode }),
        requestId: SERVICE_REQUEST_ID_PATTERN.test(requestId) ? requestId : ""
      })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw localCompanionRequestError(response, payload);
    return normalizeLocalDiagnosticNote(payload);
  }

  /**
   * Clear an unusable leftover contribution-device credential on this Mac.
   *
   * The companion deletes only the local Keychain entry and its state file;
   * no hosted device, participant, or contributed metadata is touched.
   */
  async resetContributionDeviceCredential() {
    const response = await this.fetchImpl(
      `${LOCAL_ROOT}/contribution/device-credential-reset`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1"
        },
        body: JSON.stringify({ confirm: "reset_device_credential" })
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw localCompanionRequestError(response, payload);
    return normalizeLocalContributionDeviceReset(payload);
  }

  /**
   * Stop this Mac's upload-only authority. Unlike the local repair above,
   * this is a two-sided transaction: the companion first revokes the remote
   * device bearer using the Keychain secret it alone can read, then pauses
   * local delivery and clears that exact local binding. It does not delete
   * already accepted hosted metadata or the browser's hosted session.
   */
  async disconnectContributionDevice() {
    const response = await this.fetchImpl(
      `${LOCAL_ROOT}/contribution/device-disconnect`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Usage-Monitor-Local": "1"
        },
        body: JSON.stringify({ confirm: "disconnect_this_mac" })
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw localCompanionRequestError(response, payload);
    return normalizeLocalContributionDeviceDisconnect(payload);
  }

  contributionSyncExactReview() {
    return this.localContributionMutation("sync-inspect-exact");
  }

  /**
   * Record the approve-once consent for the incremental full-history
   * contribution model (telemetry-contribution-v1.0). The route is fixed and
   * only ever called when the companion's health payload advertises the v1.0
   * sync capability; the review token proves one verified real instance of
   * the covered data was on screen, which is the first-run review-bootstrap
   * requirement carried into the approve-once model.
   */
  async approveIncrementalContribution(reviewToken) {
    if (typeof reviewToken !== "string"
        || !/^[A-Za-z0-9_-]{43}$/u.test(reviewToken)) {
      throw new TypeError("Incremental consent requires a valid review token.");
    }
    return this.localContributionMutation("incremental-approve", {
      reviewToken,
    });
  }

  async reviewAttributionContribution() {
    const review = normalizeAttributionContributionReview(
      await this.localContributionMutation("incremental-review-v11"),
    );
    if (review === null) throw new Error("Attribution review is unavailable.");
    return review;
  }

  approveAttributionContribution(review) {
    return this.localContributionMutation("incremental-approve", {
      reviewToken: review.reviewToken, consent: review.consent,
      fieldInventoryDigest: review.inventory.inventoryDigest,
    });
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
      const known = payload?.schemaVersion
        === "local-contribution-preparation-error-v0.1";
      error.code = known
        && LOCAL_PREPARATION_ERROR_CODES.has(payload?.errorCode)
        ? payload.errorCode
        : "preparation_failed";
      // The coarse code names a family of bounds; the detail names the one
      // that stopped this run. The companion already checked it against a
      // closed vocabulary, so the shape test here is the only gate needed
      // before it is shown and filed.
      error.detail = known ? preparationDetail(payload?.detail) : null;
      throw error;
    }
    return normalizeLocalContributionPreparation(payload);
  }

}

export class CommunityClient {
  constructor({
    fetchImpl = globalThis.fetch,
    getCsrfToken = () => null
  } = {}) {
    // Detached for the same reason as LocalCompanionClient: browser-native
    // fetch throws when invoked with this client as its receiver.
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.getCsrfToken = getCsrfToken;
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

  session() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/session`, this.sessionOptions());
  }

  async enroll(
    inviteCode = null,
    contributionSchemaVersion = "telemetry-contribution-v0.1",
    { deviceBootstrap = false, identity = null } = {}
  ) {
    if (typeof deviceBootstrap !== "boolean") {
      throw new TypeError("Enrollment device bootstrap selection is invalid.");
    }
    if (identity !== null && !validHostedIdentity(identity)) {
      throw new TypeError("Enrollment identity is invalid.");
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
    if (identity !== null) {
      body.identity = {
        provider: identity.provider,
        proof: identity.proof,
        verifier: identity.verifier
      };
    }
    if (typeof inviteCode === "string" && inviteCode.length > 0) body.inviteCode = inviteCode;
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/enroll`, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  /**
   * Starts hosted Google sign-in. Google's Web application client requires its
   * client secret on the token exchange even with PKCE, so the service owns
   * both the redirect and the verifier; this page never sees either.
   */
  async identityGoogleStart() {
    return startHostedSignIn(this.fetchImpl, "google");
  }

  async identityGoogleResult(state, verifier) {
    return readHostedSignInResult(this.fetchImpl, "google", state, verifier);
  }

  /**
   * Starts hosted Sign in with Apple. Apple refuses loopback redirects and
   * answers with response_mode=form_post, so the service owns both the
   * redirect target and the client secret.
   */
  async identityAppleStart() {
    return startHostedSignIn(this.fetchImpl, "apple");
  }

  async identityAppleResult(state, verifier) {
    return readHostedSignInResult(this.fetchImpl, "apple", state, verifier);
  }

  createDevicePairing(accountScoped = false) {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/me/device-pairings`, this.mutationOptions({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Re-pinned 2026-08-08 (v1.0 wiring): a telemetry participant's
        // pairing requests the v1.0 incremental consent identifier. The
        // Worker pins it on the pairing, and the companion's CLAIM of that
        // pairing is what records the server-side consent-once grant that
        // every v1.0 chunk upload is verified against — a pairing still
        // carrying "ongoing-privacy-safe-telemetry-v0.1" leaves every upload
        // refused 403 TELEMETRY_CONSENT_INVALID. The account-scoped preview
        // keeps its own single identifier.
        consentVersion: accountScoped
          ? "ongoing-privacy-safe-telemetry-v0.2"
          : "ongoing-privacy-safe-telemetry-v1.0",
        ongoingUpload: true
      })
    }));
  }

  grantAttributionContribution(review) {
    const consent = telemetryV11RequiredConsent();
    if (!review || Object.entries(consent).some(([key, value]) => review.consent?.[key] !== value)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(review.grantDeviceId ?? "")) {
      throw new TypeError("Attribution consent requires a reviewed device target.");
    }
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/me/device-telemetry-consents`, this.mutationOptions({
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: review.grantDeviceId, consent, ongoingUpload: true }),
    }));
  }

  logout() {
    return fetchJson(this.fetchImpl, `${CENTRAL_ROOT}/logout`, this.mutationOptions({
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
        series: "Expected from speed-priced API cost",
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
  // What each component contributes to a demo period's cost. Shared by the
  // period and by every model row inside it, so the two cannot drift.
  const componentCostShares = {
    input_uncached_tokens: .458,
    input_cache_read_tokens: .1535,
    input_cache_write_tokens: .0128,
    output_text_tokens: .2128,
    output_reasoning_tokens: .1629,
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
      allowanceWeighting: {
        status: "complete",
        basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
        selectedScenario: "unresolved_as_standard",
        selectedUsd: cost,
        scenarios: {
          unresolved_as_standard: {
            basisId: allowanceBasisId("unresolved_as_standard"),
            sourceWeightingStatus: "complete",
            quotaWeightedUsd: cost,
            coveredSubtotalUsd: cost,
            coverage: {
              totalEvents: usageEvents,
              observedEvents: 0,
              declaredFromConfigEvents: 0,
              assumedEvents: usageEvents,
              inferredEvents: 0,
              unknownEvents: 0
            }
          },
          unresolved_as_fast: {
            basisId: allowanceBasisId("unresolved_as_fast"),
            sourceWeightingStatus: "complete",
            quotaWeightedUsd: Number((cost * 2.5).toFixed(12)),
            coveredSubtotalUsd: Number((cost * 2.5).toFixed(12)),
            coverage: {
              totalEvents: usageEvents,
              observedEvents: 0,
              declaredFromConfigEvents: 0,
              assumedEvents: usageEvents,
              inferredEvents: 0,
              unknownEvents: 0
            }
          }
        },
        rangeUsd: null
      },
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
      durationMinutes: CODEX_WEEKLY_ALLOWANCE_MINUTES,
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
    // One demo model row, split across the same components the period uses so
    // the row reconciles with its own totals rather than with an unrelated
    // ratio. A row whose pricing status withholds a price still carries the
    // split; the table declines to show its money cells on the strength of
    // that status, which is the behaviour worth being able to review.
    const demoModelRow = (model, eventShare, tokenShare, costShare, pricingStatus) => {
      const rowTokens = Math.round(tokens * tokenShare);
      const rowCost = Number((cost * costShare).toFixed(2));
      const rowComponents = splitTokens(rowTokens);
      return {
        model,
        events: Math.round(events * eventShare),
        totalTokens: rowTokens,
        apiPriceEquivalentUsd: rowCost,
        pricingStatus,
        allowanceTrack: "primary",
        apiPriceEquivalentApplicable: true,
        components: rowComponents,
        componentCosts: Object.fromEntries(
          Object.entries(rowComponents).map(([key, count]) => [key, {
            tokens: count,
            costUsd: Number((rowCost * componentCostShares[key]).toFixed(2))
          }])
        )
      };
    };
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
        costUsd: Number((cost * componentCostShares[key]).toFixed(2))
      }])),
      // The labeled demo carries every model-row state the real payload can
      // produce, so the model table can be reviewed without waiting for a
      // matching day of real usage. That now includes the per-model token
      // split and its priced amounts, and one row that deliberately carries
      // neither, so the withheld case is reviewable too.
      byModel: [
        demoModelRow("gpt-5.6-sol", .62, .64, .66, "priced"),
        demoModelRow("gpt-5.6-terra", .18, .19, .21, "priced"),
        demoModelRow("gpt-5.4-mini", .15, .13, .09, "priced"),
        // Recognised, and deliberately carries no published price card.
        demoModelRow("codex-auto-review", .04, .02, 0, "known_unpriced"),
        // Deliberately carries no component split at all, so the table's
        // "this row cannot say" path stays reviewable beside the rows that can.
        { model: "unknown", events: Math.round(events * .05), totalTokens: Math.round(tokens * .04), apiPriceEquivalentUsd: 0, pricingStatus: "unrecognized", allowanceTrack: "primary", apiPriceEquivalentApplicable: true }
      ],
      // Metered against its own subscription allowance, so it is kept out of
      // the primary pool's totals and quotes no API-price equivalent.
      spark: {
        byModel: [
          { model: "gpt-5.3-codex-spark", events: Math.round(events * .21), totalTokens: Math.round(tokens * .07), apiPriceEquivalentUsd: 0, pricingStatus: "known_unpriced", allowanceTrack: "spark", apiPriceEquivalentApplicable: false }
        ]
      },
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
      demoAccountingPeriod("all", "Cached 31-day window", 2.62)
    ]
  };
  return normalizeDashboardPayload({
    schemaVersion: "demo-dashboard-v0.1",
    mode: "demo",
    status: "demo",
    generatedAt: nowIso,
    freshness: { status: "demo", latestObservedAt: nowIso, ageSeconds: 0 },
    quotaWindows: [
      { id: "weekly", limitId: CODEX_PRIMARY_LIMIT_ID, durationMinutes: CODEX_WEEKLY_ALLOWANCE_MINUTES, usedPercent: 39, remainingPercent: 61, resetAt: iso(lastResetMs + 7 * DAY), observedAt: nowIso, planType: "pro", status: "demo" },
      { id: "primary", limitId: CODEX_PRIMARY_LIMIT_ID, durationMinutes: CODEX_FIVE_HOUR_ALLOWANCE_MINUTES, usedPercent: 18, remainingPercent: 82, resetAt: iso(nowMs + 2 * HOUR + 11 * 60_000), observedAt: nowIso, planType: "pro", status: "demo" }
    ],
    activity: { eventCount: 8120, safeRecordCount: 11432, lastScanAt: nowIso },
    timeline: {
      bucketMinutes: 60,
      coveredAt: { startAt: iso(nowMs - 7 * DAY), endAt: nowIso },
      usage: timelineUsage,
      allowanceCapacity: {
        status: "available",
        reason: null,
        basisFamilyId: ALLOWANCE_BASIS_FAMILY_ID,
        selectedScenario: "unresolved_as_standard",
        scenarios: {
          unresolved_as_standard: {
            basisId: allowanceBasisId("unresolved_as_standard"),
            medianCapacityUsd: 1878.75,
            plausibleRangeUsd: { lower: 1640.96, upper: 2280.38 },
            qualifyingResets: 14,
            cohortId: "c7d59f1f3fc548fa3d52726ec83f47a2a273ee6c3664dcf5ee510be8d8c455a8",
            validation: {
              sameResetHoldoutMeanAbsoluteErrorPercentagePoints: 2.16,
              priorResetMeanAbsoluteErrorPercentagePoints: 3.95,
              priorResetAbsoluteBiasPercentagePoints: 1.22,
              forecastErrorP80PercentagePoints: 7.39,
              scoredPriorResets: 11,
              scoredPriorPoints: 64
            }
          },
          unresolved_as_fast: {
            basisId: allowanceBasisId("unresolved_as_fast"),
            medianCapacityUsd: 4696.875,
            plausibleRangeUsd: { lower: 4102.4, upper: 5700.95 },
            qualifyingResets: 14,
            cohortId: "c7d59f1f3fc548fa3d52726ec83f47a2a273ee6c3664dcf5ee510be8d8c455a8",
            validation: {
              sameResetHoldoutMeanAbsoluteErrorPercentagePoints: 2.16,
              priorResetMeanAbsoluteErrorPercentagePoints: 3.95,
              priorResetAbsoluteBiasPercentagePoints: 1.22,
              forecastErrorP80PercentagePoints: 7.39,
              scoredPriorResets: 11,
              scoredPriorPoints: 64
            }
          }
        },
        accountAttribution: {
          status: "historical_unattributed",
          maySpanMultipleAccounts: true
        }
      },
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
        { priority: "P0", title: "Unknown model tokens", evidence: "Some historical events cannot be matched to an official API price card." },
        { priority: "P0", title: "Integer quota display", evidence: "Quota observations are rounded to whole percentage points." },
        { priority: "P1", title: "Shared agentic surfaces", evidence: "Work, Workspace Agents, and Voice task work may draw from the same pool." },
        { priority: "P1", title: "Fast-mode attribution", evidence: "Historical records do not always identify the subscription speed tier." }
      ]
    }
  });
}
