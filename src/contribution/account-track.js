import { deriveExportPseudonym, deriveExportPseudonymV2 } from "@app-usagemonitor/identity-core";

export const TELEMETRY_ACCOUNT_TRACK_VERSION = "account-track-v1";
export const TELEMETRY_ACCOUNT_TRACK_V2_VERSION = "account-track-v2";
export const UNATTRIBUTED_ACCOUNT_TRACK_ID = "unattributed";

const LOCAL_ACCOUNT_SCOPE_PATTERN = /^account:v1:([a-f0-9]{64})$/u;
const CENTRAL_PARTICIPANT_PATTERN =
  /^participant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCOUNT_TRACK_PATTERN = /^account-track:v1:[a-f0-9]{64}$/u;
const ACCOUNT_TRACK_V2_PATTERN = /^account-track:v2:[a-f0-9]{64}$/u;
const OPENAI_ACCOUNT_SCOPE_PATTERN = /^openai-account:v1:([A-Za-z0-9_-]{43})$/u;
const ACCOUNT_SCOPE_KEYS = new Set(["status", "reason", "version", "scopeId", "planType"]);
const ACCOUNT_SCOPE_UNAVAILABLE_REASONS = new Set([
  "missing_account", "malformed_subject", "missing_secret", "credential_locked",
  "credential_migration_required", "credential_unavailable",
]);
const ENROLLMENT_NAMESPACE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const PROVIDERS = new Set([
  "openai_codex",
  "anthropic_claude_code",
]);

function assertCentralParticipantId(value) {
  if (typeof value !== "string" || !CENTRAL_PARTICIPANT_PATTERN.test(value)) {
    throw new TypeError("Central participant identifier is invalid");
  }
  return value.toLowerCase();
}

function assertProvider(value) {
  if (typeof value !== "string" || !PROVIDERS.has(value)) {
    throw new TypeError("Account-track provider is invalid");
  }
  return value;
}

/**
 * Convert the installation-local export account scope into the only account
 * continuity value eligible for a central contribution.
 *
 * The local scope is itself a keyed digest. It becomes key material for a
 * third, central-participant-scoped derivation and is never returned. A new
 * central enrollment therefore cannot be linked by comparing this output.
 */
export function deriveTelemetryAccountTrackId(
  localAccountScopeId,
  centralParticipantId,
  provider,
) {
  const participant = assertCentralParticipantId(centralParticipantId);
  const safeProvider = assertProvider(provider);
  if (localAccountScopeId === UNATTRIBUTED_ACCOUNT_TRACK_ID) {
    return UNATTRIBUTED_ACCOUNT_TRACK_ID;
  }
  const match = typeof localAccountScopeId === "string"
    ? LOCAL_ACCOUNT_SCOPE_PATTERN.exec(localAccountScopeId)
    : null;
  if (!match) throw new TypeError("Local account scope is invalid");

  const localScopeKey = Buffer.from(match[1], "hex");
  try {
    const track = deriveExportPseudonym(
      localScopeKey,
      "account-track",
      `${safeProvider}\u0000${participant}`,
    );
    if (!ACCOUNT_TRACK_PATTERN.test(track)) {
      throw new Error("Derived account track is invalid");
    }
    return track;
  } finally {
    localScopeKey.fill(0);
  }
}

export function isTelemetryAccountTrackId(value) {
  return value === UNATTRIBUTED_ACCOUNT_TRACK_ID
    || (typeof value === "string" && ACCOUNT_TRACK_PATTERN.test(value));
}

function observedAccountScopeId(value) {
  if (value === null || value === undefined || value === UNATTRIBUTED_ACCOUNT_TRACK_ID) return null;
  if (typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.keys(value).length !== ACCOUNT_SCOPE_KEYS.size
      || Object.keys(value).some((key) => !ACCOUNT_SCOPE_KEYS.has(key))
      || value.version !== "openai-account-v1"
      || !(value.planType === null || (typeof value.planType === "string"
        && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value.planType)))) {
    throw new TypeError("Observed account scope is invalid");
  }
  if (value.status === "unavailable" && value.scopeId === null
      && ACCOUNT_SCOPE_UNAVAILABLE_REASONS.has(value.reason)) return null;
  const match = value.status === "available" && value.reason === null && typeof value.scopeId === "string"
    ? OPENAI_ACCOUNT_SCOPE_PATTERN.exec(value.scopeId)
    : null;
  if (!match || Buffer.from(match[1], "base64url").toString("base64url") !== match[1]) {
    throw new TypeError("Observed account scope is invalid");
  }
  return value.scopeId;
}

function accountTrackDestination(value) {
  if (value === null || value === undefined) return null;
  let destination;
  try {
    if (typeof value !== "string" || value.length > 2_048) throw new Error();
    destination = new URL(value);
  } catch {
    throw new TypeError("Account-track destination is invalid");
  }
  const allowedProtocol = destination.protocol === "https:"
    || (destination.protocol === "http:"
      && ["127.0.0.1", "[::1]", "localhost"].includes(destination.hostname));
  if (!allowedProtocol || value !== destination.origin) {
    throw new TypeError("Account-track destination is invalid");
  }
  return value;
}

/** A captured binding is authority supplied by the consented local settings. */
export function sanitizeTelemetryAttributionBinding(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join("\0") !== "destinationOrigin\0enrollmentNamespace"
        || !ENROLLMENT_NAMESPACE_PATTERN.test(value.enrollmentNamespace)
        || typeof value.enrollmentNamespace !== "string") return null;
    const destinationOrigin = accountTrackDestination(value.destinationOrigin);
    return destinationOrigin === null ? null : Object.freeze({ destinationOrigin,
      enrollmentNamespace: value.enrollmentNamespace });
  } catch { return null; }
}

/**
 * Derive a successor track from the live typed login-subject scope. V1 above is
 * frozen: it accepts a different, retired local encoding and is not an adapter
 * for this scope.
 *
 * The enrollment namespace must come from this observation's authenticated,
 * destination-bound enrollment, NOT the current profile/device/wire version.
 * A historical row without that binding remains unattributed after re-pairing.
 * This pure helper cannot create a binding, load/create a Keychain item, or
 * prove that two device-local roots describe the same provider account.
 *
 * The caller owns and disposes the leased existing account-observation root.
 * Identity-core copies/zeroes its working key; no new secret is persisted here.
 * Plan is deliberately not identity: callers must retain a separate plan era.
 */
export function deriveTelemetryAccountTrackIdV2({
  accountScope = null,
  accountObservationSecret = null,
  destinationOrigin = null,
  enrollmentNamespace = null,
} = {}) {
  const scopeId = observedAccountScopeId(accountScope);
  const destination = accountTrackDestination(destinationOrigin);
  if (enrollmentNamespace !== null && enrollmentNamespace !== undefined
      && (typeof enrollmentNamespace !== "string" || !ENROLLMENT_NAMESPACE_PATTERN.test(enrollmentNamespace))) {
    throw new TypeError("Account-track enrollment namespace is invalid");
  }
  if (accountObservationSecret !== null && accountObservationSecret !== undefined
      && (!Buffer.isBuffer(accountObservationSecret) || accountObservationSecret.byteLength !== 32)) {
    throw new TypeError("Account observation root is invalid");
  }
  if (scopeId === null || destination === null || accountObservationSecret == null || enrollmentNamespace == null) {
    return UNATTRIBUTED_ACCOUNT_TRACK_ID;
  }
  return deriveExportPseudonymV2(accountObservationSecret, "account-track", JSON.stringify([
    "openai_codex",
    destination,
    enrollmentNamespace,
    "openai-account-v1",
    scopeId,
  ]));
}

export function isTelemetryAccountTrackIdV2(value) {
  return value === UNATTRIBUTED_ACCOUNT_TRACK_ID
    || (typeof value === "string" && ACCOUNT_TRACK_V2_PATTERN.test(value));
}

/** A continuity era requires an explicit source boundary, not merely a plan. */
export function deriveTelemetryPlanEraIdV1({
  accountTrackId = UNATTRIBUTED_ACCOUNT_TRACK_ID,
  planType,
  eraStartOccurrenceId = null,
  accountObservationSecret = null,
  destinationOrigin = null,
  enrollmentNamespace = null,
} = {}) {
  const destination = accountTrackDestination(destinationOrigin);
  if (!isTelemetryAccountTrackIdV2(accountTrackId)
      || typeof planType !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(planType)
      || (eraStartOccurrenceId !== null && (typeof eraStartOccurrenceId !== "string"
        || !/^[A-Za-z0-9._:-]{8,128}$/u.test(eraStartOccurrenceId)))) {
    throw new TypeError("Plan era evidence is invalid");
  }
  if (accountObservationSecret != null
      && (!Buffer.isBuffer(accountObservationSecret) || accountObservationSecret.byteLength !== 32)) {
    throw new TypeError("Account observation root is invalid");
  }
  if (enrollmentNamespace != null
      && (typeof enrollmentNamespace !== "string" || !ENROLLMENT_NAMESPACE_PATTERN.test(enrollmentNamespace))) {
    throw new TypeError("Account-track enrollment namespace is invalid");
  }
  if (destination === null || accountObservationSecret == null || enrollmentNamespace == null
      || eraStartOccurrenceId === null || planType === "unknown") return null;
  return deriveExportPseudonym(accountObservationSecret, "plan-era", JSON.stringify([
    "openai_codex", destination, enrollmentNamespace, accountTrackId, planType, eraStartOccurrenceId,
  ]));
}
