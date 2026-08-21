import {
  assertAdmissionBindings,
  assertAttemptAllowed,
  assertPublicAggregateReadAllowed,
  assertUploadAuthorizationBindings,
  assertUploadAuthorizationAllowed,
  assertUploadIngressRateLimitBindings,
  assertUploadIngressRequestAllowed,
  configuredEnrollmentMode,
  parseInviteGrant,
} from "./admission";
import {
  acquireUploadIngressLease,
  assertUploadIngressConfiguration,
  probeUploadIngressBudget,
  readUploadIngressStatus,
  releaseUploadIngressLease,
  startUploadIngressLeaseHeartbeat,
  uploadIngressBodyReadPolicy,
} from "./upload-ingress-admission";
import {
  readBoundedRequestBody,
  type BoundedBodyReadPolicy,
} from "./bounded-body";
import {
  assertAccountScopedLocalPreview,
  configuredAccountScopedIngestMode,
} from "./account-scoped-ingest";
import {
  ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  BACKEND_LIFECYCLE_STALE_MILLISECONDS,
  JSON_HEADERS,
  MAX_PARTICIPANT_PROFILE_HISTORY_ITEMS,
  MAX_REQUEST_BYTES,
  MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT,
  ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION,
  ONGOING_TELEMETRY_CONSENT_VERSION,
  ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION,
  QUARANTINE_RETENTION_MILLISECONDS,
  TELEMETRY_CONSENT_VERSION,
} from "./constants";
import {
  adminIdentityKeyConfigured,
  authorizeAdminIdentity,
  beginAdminOperation,
  finishAdminOperation,
  pruneDiagnosticErrors,
  readAdminOverview,
  recordDiagnosticError,
  setCollectionControls,
  validDiagnosticReference,
  type AdminAction,
  type CollectionControlReason,
} from "./admin-operations";
import { authorizeAdminEmail, verifyAdminAccessAssertion } from "./admin-access";
import { readDistributionAnalytics } from "./distribution-analytics";
import {
  githubUnavailable,
  readGithubDistributionSnapshot,
  syncGithubDistributionSnapshots,
} from "./github-distribution-history";
import {
  adminHostname,
  adminUiResponse,
  canonicalPublicRedirectUrl,
  isAdminSurfacePath,
} from "./admin-ui";
import {
  buildCommunityWeeklySnapshot,
  readLatestCommunityWeeklySnapshot,
  readParticipantCommunityComparison,
  rebuildPendingCommunityWeeklySnapshots,
} from "./community-snapshots";
import {
  assertCollectionControl,
  readCollectionControls,
} from "./collection-controls";
import {
  decryptSyntheticEnvelope,
  publicEnvelopeKey,
  randomSecret,
  sha256Hex,
} from "./crypto";
import { parseStoredRecordJson } from "./stored-record";
import {
  abandonDeviceUploadAuthorization,
  authenticateDevice,
  claimDevicePairing,
  claimDeviceUploadAuthorization,
  createDevicePairing,
  createDeviceUploadAuthorization,
  disconnectAuthenticatedDevice,
  listParticipantDevices,
  purgeStaleDeviceLifecycleRows,
  recordDeviceUploadReceipt,
  revokeParticipantDevice,
  rotateDeviceCredential,
  type DeviceTransportConsentVersion,
} from "./device-auth";
import {
  ApiError,
  errorResponse,
  jsonResponse,
} from "./errors";
import {
  assertDeletionOwner,
  contributionCount,
  contributionForResponse,
  contributionHistoryMetadata,
  enroll,
  envelopeDigest,
  existingContribution,
  finishParticipantDeletion,
  insertContribution,
  listContributions,
  markParticipantDeleting,
  participantIdentityLinkKeyForDeletion,
  participantIdentityLinkState,
  reattachParticipantByLinkKey,
  recoverAccess,
  revokeSession,
  securityReset,
} from "./repository";
import {
  APPLE_SIGNIN_STATE_PATTERN,
  appleAuthorizeUrl,
  appleSignInConfiguration,
  exchangeAppleAuthorizationCode,
  generateAppleSignInNonce,
  hashAppleSignInNonce,
} from "./identity-apple";
import {
  GOOGLE_SIGNIN_STATE_PATTERN,
  exchangeGoogleAuthorizationCode,
  googleAuthorizeUrl,
  googleCodeChallenge,
  googleSignInConfiguration,
} from "./identity-google";
import { assertPinnedIdentityLinkSecretConfiguration } from "./identity-link-configuration";
import { identityRequired, verifyHostedIdentity } from "./identity-oidc";
import {
  claimPendingAppleSignInHandoff,
  completeAppleSignInHandoff,
  deleteExpiredAppleSignInHandoffs,
  deliverAppleSignInHandoff,
  discardClaimedAppleSignInHandoff,
  discardPendingAppleSignInHandoff,
  insertAppleSignInHandoff,
  readPendingAppleSignInHandoff,
} from "./identity-handoff-repository";
import {
  clearPendingQuarantineObject,
  putTrackedQuarantineObject,
  readQuarantineReconciliationStatus,
  reconcilePendingQuarantineObjects,
} from "./quarantine-reconciliation";
import {
  hasIdentityReenrollmentCooldownDigest,
  hasDeletionTombstone,
  identityReenrollmentCooldownDigest,
  purgeExpiredDeletionTombstones,
  purgeExpiredIdentityReenrollmentCooldowns,
  purgeExpiredPrimaryIdentityReenrollmentCooldowns,
  recordIdentityReenrollmentCooldownFromDigest,
  recordDeletionTombstone,
  recordPrimaryIdentityReenrollmentCooldown,
  runBackendLifecycle,
} from "./retention";
import {
  assertSignInStartAdmission,
  assertSignInStartAdmissionConfiguration,
  purgeExpiredSignInStartAdmissions,
} from "./signin-admission";
import {
  matchWorkerRoute,
  type ApiWorkerRouteId,
} from "./route-registry";
import { handleSparkleAppcastGuard } from "./sparkle-appcast-guard";
import {
  assertAdminCsrf,
  assertCsrf,
  assertSameOrigin,
  abandonUploadAuthorization,
  authenticateSession,
  claimUploadAuthorization,
  clearedSessionCookie,
  createUploadAuthorizationMaterial,
  hasSessionCookie,
  recordUploadReceipt,
  sessionCookie,
  storeUploadAuthorization,
  type SessionPrincipal,
} from "./session";
import {
  type TelemetryContributionAdmission,
  deleteTelemetryContribution,
  existingTelemetryContribution,
  insertTelemetryContribution,
  listRecentTelemetryContributions,
  markTelemetryContributionDeleting,
  personalStats,
  telemetryContributionById,
  telemetryContributionAdmission,
  telemetryContributionCount,
  telemetryContributionPage,
  telemetryContributionHistoryMetadata,
  telemetryContributionMetadata,
  telemetryContributionR2KeyPage,
  telemetryEnvelopeDigest,
  telemetryPlaintextDigest,
  telemetryRecordsForContribution,
} from "./telemetry-repository";

// Wrangler discovers Durable Object classes through the Worker module's named
// exports. The class itself owns only opaque short-lived admission leases.
export { UploadIngressBudget } from "./ingress-budget";

const DEPLOYMENT_SOURCE_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/u;

function configuredDeploymentSourceCommit(env: Env): string | null {
  const configured = (env as Env & {
    DEPLOYMENT_SOURCE_COMMIT?: unknown;
  }).DEPLOYMENT_SOURCE_COMMIT;
  if (configured === undefined) return null;
  if (typeof configured !== "string"
      || !DEPLOYMENT_SOURCE_COMMIT_PATTERN.test(configured)) {
    throw new ApiError(503, "DEPLOYMENT_SOURCE_COMMIT_INVALID");
  }
  return configured;
}

function telemetryContributionLimitError(
  admission: TelemetryContributionAdmission,
  nowEpoch = Date.now(),
): ApiError {
  const retryAtEpoch = Date.parse(admission.window.endsAt);
  const retryAfterSeconds = Number.isFinite(retryAtEpoch)
    ? Math.max(1, Math.ceil((retryAtEpoch - nowEpoch) / 1000))
    : 1;
  return new ApiError(429, "CONTRIBUTION_LIMIT_REACHED", {
    publicDetails: {
      admission,
      retryAt: admission.window.endsAt,
    },
    responseHeaders: {
      "retry-after": String(retryAfterSeconds),
    },
  });
}
import {
  MAX_TELEMETRY_V1_CHUNK_CANONICAL_BYTES,
  TELEMETRY_V1_ENVELOPE_SCHEMA_VERSION,
  assertTelemetryV1ConsentCurrent,
  parseTelemetryV1Chunk,
  validateTelemetryV1Envelope,
} from "./telemetry-v1";
import {
  MAX_SYNC_MANIFEST_RANGE_DAYS,
  currentTelemetryV1Chunk,
  existingTelemetryV1ChunkByEnvelopeDigest,
  insertTelemetryV1Chunk,
  telemetryV1AcknowledgedThroughDay,
  telemetryV1ChunkAdmission,
  telemetryV1ChunkAdmissionError,
  telemetryV1ChunkCount,
  telemetryV1ChunkId,
  telemetryV1ChunkR2KeyPage,
  telemetryV1DeviceConsentCurrent,
  telemetryV1DeviceForUploadAuthorization,
  telemetryV1SyncManifest,
  telemetryV1SyncState,
  type TelemetryV1ChunkRow,
} from "./telemetry-v1-repository";
import {
  readPublishedCommunityDailyAggregates,
  rebuildPendingCommunityDailyAggregates,
} from "./community-daily-aggregates";
import {
  captureAdminMetricSnapshot,
  readAdminMetricsHistory,
} from "./admin-metrics-history";
import { canonicalJson } from "./canonical-json";
import {
  insertTelemetryContributionV02,
} from "./telemetry-v0.2-repository";
import {
  validateTelemetryContributionV02,
} from "./telemetry-v0.2";
import {
  validateTelemetryContribution,
  validateTelemetryEnvelope,
} from "./telemetry-validation";
import {
  validateEnvelope,
  validateSyntheticContribution,
} from "./validation";

const CONTROL_BODY_READ_POLICY = Object.freeze({
  maximumTotalMilliseconds: 15_000,
  maximumIdleMilliseconds: 5_000,
} satisfies BoundedBodyReadPolicy);

async function readBoundedJson(
  request: Request,
  policy: BoundedBodyReadPolicy = CONTROL_BODY_READ_POLICY,
): Promise<{
  bytes: Uint8Array;
  raw: string;
  value: unknown;
}> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new ApiError(415, "CONTENT_TYPE_INVALID");
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw new ApiError(400, "BODY_INVALID");
    if (length > MAX_REQUEST_BYTES) throw new ApiError(413, "BODY_TOO_LARGE");
  }
  const combined = await readBoundedRequestBody(request, MAX_REQUEST_BYTES, policy);
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(combined);
    return { bytes: combined, raw, value: JSON.parse(raw) as unknown };
  } catch {
    throw new ApiError(400, "BODY_INVALID");
  }
}

const UPLOAD_AUTHORIZATION_HEADER =
  /^Upload um_(?:device_)?upload_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/u;

/**
 * Reject requests that cannot possibly be a contribution before spending a
 * Rate Limit key or shared ingress slot. The bound reader rechecks these
 * fields before consuming the body; this is a cheap pre-body fence only.
 */
function contributionRequestPreflight(request: Request): string {
  if (hasSessionCookie(request.headers.get("cookie"))) {
    throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  }
  const authorization = request.headers.get("authorization");
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new ApiError(415, "CONTENT_TYPE_INVALID");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new ApiError(400, "BODY_INVALID");
    }
    if (length > MAX_REQUEST_BYTES) throw new ApiError(413, "BODY_TOO_LARGE");
  }
  if (!request.body) throw new ApiError(400, "BODY_INVALID");
  if (typeof authorization !== "string"
      || !UPLOAD_AUTHORIZATION_HEADER.test(authorization)) {
    throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  }
  return authorization;
}

/**
 * Bounded reader for the one form-encoded request this service accepts:
 * Apple's response_mode=form_post callback. It is deliberately separate from
 * readBoundedJson, keeps its own much smaller cap, and never parses anything
 * beyond application/x-www-form-urlencoded.
 */
async function readBoundedForm(
  request: Request,
  maximumBytes: number,
): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new ApiError(415, "CONTENT_TYPE_INVALID");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new ApiError(400, "BODY_INVALID");
    }
    if (length > maximumBytes) throw new ApiError(413, "BODY_TOO_LARGE");
  }
  const combined = await readBoundedRequestBody(
    request,
    maximumBytes,
    CONTROL_BODY_READ_POLICY,
  );
  try {
    return new URLSearchParams(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
        .decode(combined),
    );
  } catch {
    throw new ApiError(400, "BODY_INVALID");
  }
}

function methodNotAllowed(allowed: string[]): never {
  const error = new ApiError(405, "METHOD_NOT_ALLOWED");
  Object.defineProperty(error, "allowed", { value: allowed });
  throw error;
}

function allowedHeader(error: ApiError): HeadersInit | undefined {
  const value = Reflect.get(error, "allowed");
  return Array.isArray(value) ? { allow: value.join(", ") } : undefined;
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function hasExactEnvelopeKeyOccurrences(raw: string): boolean {
  const keys = [...raw.matchAll(/"([^"\\]+)"\s*:/gu)].map((match) => match[1]);
  const expected = [
    "schemaVersion", "synthetic", "keyId", "wrappedKey", "iv", "ciphertext",
  ].sort();
  return keys.length === expected.length
    && keys.sort().every((key, index) => key === expected[index]);
}

async function handleEnroll(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  assertSameOrigin(request);
  const mode = configuredEnrollmentMode(env);
  assertAdmissionBindings(env);
  // "disabled" pauses NEW participation only. An identity that already links
  // to a participant reattaches below without creating anything, so the
  // refusal moves to the fresh-enrollment fall-through instead of the door.
  await assertCollectionControl(env.USAGE_MONITOR_DB, "enrollment");
  await assertAttemptAllowed(
    env.ENROLLMENT_RATE_LIMIT,
    env.CLIENT_ATTEMPT_RATE_LIMIT,
    request,
    env,
    "enrollment",
  );
  const body = await readBoundedJson(request);
  const accountScopedEnrollment = typeof body.value === "object"
    && body.value !== null
    && !Array.isArray(body.value)
    && Reflect.get(body.value, "consentVersion")
      === ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION
    && Reflect.get(body.value, "syntheticOnly") === false;
  if (typeof body.value !== "object"
    || body.value === null
    || Array.isArray(body.value)
    || !Object.hasOwn(body.value, "consentVersion")
    || !Object.hasOwn(body.value, "syntheticOnly")
    || !(
      (Reflect.get(body.value, "consentVersion") === "synthetic-preview-v0.1"
        && Reflect.get(body.value, "syntheticOnly") === true)
      || (Reflect.get(body.value, "consentVersion") === TELEMETRY_CONSENT_VERSION
        && Reflect.get(body.value, "syntheticOnly") === false)
      || accountScopedEnrollment
    )) {
    throw new ApiError(400, "BODY_INVALID");
  }
  if (accountScopedEnrollment) {
    assertAccountScopedLocalPreview(request, env);
  }
  const deviceBootstrap = Reflect.get(body.value, "deviceBootstrap");
  const expectedOngoingConsentVersion = accountScopedEnrollment
    ? ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION
    : ONGOING_TELEMETRY_CONSENT_VERSION;
  const deviceBootstrapRequested = deviceBootstrap !== undefined;
  if (deviceBootstrapRequested
      && (
        Reflect.get(body.value, "syntheticOnly") !== false
        || typeof deviceBootstrap !== "object"
        || deviceBootstrap === null
        || Array.isArray(deviceBootstrap)
        || Object.keys(deviceBootstrap).length !== 2
        || Reflect.get(deviceBootstrap, "ongoingUpload") !== true
        || Reflect.get(deviceBootstrap, "consentVersion")
          !== expectedOngoingConsentVersion
      )) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const identityValue = Reflect.get(body.value, "identity");
  const identityProvided = identityValue !== undefined;
  const keys = Object.keys(body.value);
  const allowedKeys = mode === "invite_only"
    ? ["consentVersion", "syntheticOnly", "inviteCode", "deviceBootstrap", "identity"]
    : ["consentVersion", "syntheticOnly", "deviceBootstrap", "identity"];
  if (keys.some((key) => !allowedKeys.includes(key))
      || ((mode === "local_open" || mode === "open")
        && keys.length !== 2
          + (deviceBootstrapRequested ? 1 : 0)
          + (identityProvided ? 1 : 0))) {
    throw new ApiError(400, "BODY_INVALID");
  }
  if (identityRequired(env) && !identityProvided) {
    throw new ApiError(401, "IDENTITY_REQUIRED");
  }
  if (identityRequired(env)) {
    await assertPinnedIdentityLinkSecretConfiguration(
      env.USAGE_MONITOR_DB,
      Reflect.get(env, "IDENTITY_LINK_SECRET"),
      Reflect.get(env, "IDENTITY_LINK_SECRET_VERSION"),
    );
  }
  const verifiedIdentity = identityProvided
    ? await consumeHostedIdentityProof(env.USAGE_MONITOR_DB, identityValue)
    : null;
  const identityCooldownDigest = verifiedIdentity !== null
    ? await assertIdentityReenrollmentAllowed(
      env,
      verifiedIdentity.linkKeyHex,
    )
    : null;
  if (deviceBootstrapRequested) {
    await assertCollectionControl(
      env.USAGE_MONITOR_DB,
      "uploadRegistration",
    );
  }
  const consentVersion = Reflect.get(body.value, "consentVersion") as string;
  const syntheticOnly = Reflect.get(body.value, "syntheticOnly");
  const reattached = verifiedIdentity
    ? await reattachParticipantByLinkKey(
      env.USAGE_MONITOR_DB,
      verifiedIdentity.linkKeyHex,
      consentVersion,
      { deviceBootstrap: deviceBootstrapRequested },
    )
    : null;
  if (reattached === null && mode === "disabled") {
    throw new ApiError(503, "ENROLLMENT_DISABLED");
  }
  const inviteGrant = reattached === null && mode === "invite_only"
    ? await parseInviteGrant(Reflect.get(body.value, "inviteCode"))
    : null;
  const enrollment = reattached ?? await (async () => {
    try {
      return await enroll(
        env.USAGE_MONITOR_DB,
        consentVersion,
        inviteGrant,
        {
          deviceBootstrap: deviceBootstrapRequested,
          openCommunityEligibility: mode === "open"
            && syntheticOnly === false,
          identityLinkKey: verifiedIdentity?.linkKeyHex ?? null,
          identityCooldownDigest,
        },
      );
    } catch (error) {
      // The primary trigger is the linearization point for the active →
      // deleting → removed race. Map its expected rejection without exposing
      // a database error; any unrecognised write failure remains fail-closed.
      if (identityCooldownDigest !== null
          && await hasIdentityReenrollmentCooldownDigest(
            env.USAGE_MONITOR_DB,
            identityCooldownDigest,
          )) {
        throw new ApiError(409, "IDENTITY_REENROLLMENT_COOLDOWN");
      }
      throw error;
    }
  })();
  return jsonResponse({
    schemaVersion: "participant-bootstrap-v0.1",
    state: enrollment.pairing ? "pairing_ready" : "enrolled",
    participantId: enrollment.participantId,
    csrfToken: enrollment.csrfToken,
    recoveryCode: enrollment.recoveryCode,
    consentVersion,
    invitation: enrollment.invitation,
    session: {
      state: "active",
      issuedAt: enrollment.session.issuedAt,
      expiresAt: enrollment.session.expiresAt,
    },
    recovery: {
      state: "issued",
      issuedAt: enrollment.session.issuedAt,
      expiresAt: null,
      requiresAcknowledgement: true,
    },
    pairing: enrollment.pairing ? {
      state: "claimable",
      scope: "upload_registration",
      oneUse: true,
      pairingCode: enrollment.pairing.pairingCode,
      issuedAt: enrollment.pairing.issuedAt,
      expiresAt: enrollment.pairing.expiresAt,
    } : null,
  }, 201, { "set-cookie": sessionCookie(enrollment.session) });
}

// A handoff row has two phases, and each phase is bounded by its own clock.
// `expires_at` always holds the deadline of the phase the row is currently in,
// so exactly one deadline is ever live for a row and the purge query, its
// index, and the "expired reads as invalid, never as pending" rule are all
// unchanged.
//
// Phase 1 — authorization, from the start route until the provider callback
// fills the row. The row holds no credential here: an unguessable 384-bit
// state and a nonce digest, nothing that can be replayed against anything.
// Its deadline is measured from the instant the state was minted, which is
// correct, because that is what the deadline bounds: an unused state. What it
// has to cover, though, is an entire human round trip — a cold-starting
// browser, an account chooser, a password, a second factor, and Apple's
// Hide-My-Email decision. Five minutes sits below that; ten is the
// conventional authorization-request lifetime and matches the provider's own
// authorization-code lifetime, so a careful reader is no longer refused at the
// callback for a delay that is not a security event.
const SIGNIN_HANDOFF_AUTHORIZATION_TTL_MILLISECONDS = 10 * 60 * 1000;
// Phase 2 — delivery, from the moment the callback mints the opaque proof
// until the dashboard collects it. The proof IS a bearer credential, so this
// deadline is measured from the instant it was minted rather than from
// whatever happened to be left of phase 1. Under the previous single deadline
// the collectable window was `TTL minus round-trip duration`, which tends to
// zero in exactly the case a careful user produces: a proof minted at 4:57
// lived three seconds and expired before the dashboard's next poll. Measuring
// from the mint gives every proof the same guaranteed window. The ceiling on
// how long a proof can exist is unchanged at five minutes — only the floor
// moves, from zero to five minutes.
const SIGNIN_HANDOFF_DELIVERY_TTL_MILLISECONDS = 5 * 60 * 1000;
// A callback holds its processing claim for this long before another callback
// may re-claim the row. It must comfortably exceed the provider request timeout
// (10s, capped at 60s) plus verification so a legitimately slow exchange is
// never preempted, while still freeing a crashed claimant well inside the
// 10-minute authorization window for one bounded retry.
const SIGNIN_HANDOFF_PROCESSING_LEASE_MILLISECONDS = 60 * 1000;
const MAX_APPLE_CALLBACK_BYTES = 16 * 1024;
// Google returns its authorization code in the redirect's query string. The
// code itself is bounded by the exchange, and this bounds the whole callback
// URL so an oversized redirect is refused before anything is looked up.
const MAX_GOOGLE_CALLBACK_URL_LENGTH = 8 * 1024;
const SIGNIN_HANDOFF_PROOF_PATTERN = /^[A-Za-z0-9_-]{64}$/u;
// The initiating client generates an unguessable verifier, keeps it, and sends
// only SHA-256(verifier) as `binding` when it starts the flow. It re-presents
// the raw verifier to collect the result and again when enrollment consumes the
// proof. The verifier follows RFC 7636's 43-128 character range; the binding is
// its lowercase-hex digest.
const SIGNIN_HANDOFF_VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
const SIGNIN_HANDOFF_BINDING_PATTERN = /^[0-9a-f]{64}$/u;
const SIGNIN_COMPLETED_MESSAGE = "Signed in — return to TiboTattle.";
const SIGNIN_NOT_COMPLETED_MESSAGE =
  "Sign-in was not completed. Return to TiboTattle and start the sign-in again.";
// This is the fixed, registered macOS application URL from the signed bundle.
// It is deliberately not derived from a callback request, state, code, or
// provider payload, so returning to the app reveals nothing from the OAuth
// exchange.
const SIGNIN_CALLBACK_APP_OPEN_URL = "usagemonitor://open";

/**
 * A disabled enrollment mode pauses NEW participation only; an existing
 * participant's identity reattaches through this same OAuth ceremony, so the
 * ceremony must stay open while the mode is disabled. The fresh-enrollment
 * refusal happens at the enrollment write, after the reattach check.
 */
async function assertHostedSignInStartAllowed(env: Env): Promise<void> {
  configuredEnrollmentMode(env);
  // The collection control is the other operator containment switch. Check it
  // before an edge budget, coordinated admission slot, or provider redirect so
  // a temporarily paused service cannot create stranded OAuth handoffs.
  await assertCollectionControl(env.USAGE_MONITOR_DB, "enrollment");
  if (identityRequired(env)) {
    await assertPinnedIdentityLinkSecretConfiguration(
      env.USAGE_MONITOR_DB,
      Reflect.get(env, "IDENTITY_LINK_SECRET"),
      Reflect.get(env, "IDENTITY_LINK_SECRET_VERSION"),
    );
  }
}

/**
 * Production sign-in is deliberately pinned to one configured HTTPS origin.
 * In particular, no request-derived Workers hostname can become an OAuth
 * callback merely because it reaches this Worker. Local development keeps the
 * request origin so the offline harness remains self-contained.
 */
function signInCallbackUrl(
  request: Request,
  env: Env,
  provider: "apple" | "google",
): string {
  const url = new URL(request.url);
  if (url.protocol !== "https:") {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  if (!identityRequired(env)) {
    return `${url.origin}/api/v1/identity/${provider}/callback`;
  }
  const rawOrigin = Reflect.get(env, "PUBLIC_ORIGIN");
  let configured: URL;
  try {
    configured = new URL(typeof rawOrigin === "string" ? rawOrigin : "");
  } catch {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  if (configured.protocol !== "https:"
      || configured.origin !== rawOrigin
      || configured.pathname !== "/"
      || configured.search !== ""
      || configured.hash !== "") {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  if (url.origin !== configured.origin) throw new ApiError(404, "NOT_FOUND");
  return `${configured.origin}/api/v1/identity/${provider}/callback`;
}

function hostedIdentityProof(value: unknown): {
  provider: "apple" | "google";
  proof: string;
  verifier: string;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  const provider = Reflect.get(value, "provider");
  const proof = Reflect.get(value, "proof");
  const verifier = Reflect.get(value, "verifier");
  if (Object.keys(value).sort().join("\0")
        !== ["proof", "provider", "verifier"].join("\0")
      || (provider !== "apple" && provider !== "google")
      || typeof proof !== "string"
      || !SIGNIN_HANDOFF_PROOF_PATTERN.test(proof)
      || typeof verifier !== "string"
      || !SIGNIN_HANDOFF_VERIFIER_PATTERN.test(verifier)) {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  return { provider, proof, verifier };
}

async function consumeHostedIdentityProof(
  db: D1Database,
  identity: unknown,
): Promise<{ provider: "apple" | "google"; linkKeyHex: string }> {
  const { provider, proof, verifier } = hostedIdentityProof(identity);
  const table = provider === "apple"
    ? "apple_signin_handoffs"
    : "google_signin_handoffs";
  const nowIso = new Date().toISOString();
  // Consumption carries the initiator binding through to the sink: the delivered
  // proof is a bearer credential, so a leaked proof alone cannot reattach a
  // participant — the same verifier that collected it must be re-presented here.
  const bindingHash = await sha256Hex(verifier);
  const claimed = await db.prepare(
    `DELETE FROM ${table}
      WHERE proof = ?
        AND binding_hash = ?
        AND identity_link_key IS NOT NULL
        AND delivered_at IS NOT NULL
        AND expires_at > ?
      RETURNING identity_link_key AS linkKeyHex`,
  ).bind(proof, bindingHash, nowIso).first<{ linkKeyHex: string }>();
  if (!claimed || !/^[0-9a-f]{64}$/u.test(claimed.linkKeyHex)) {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  return { provider, linkKeyHex: claimed.linkKeyHex };
}

/**
 * A proof is consumed before this check, so a caller cannot replay one hosted
 * handoff while probing the cooldown. Existing active participants are
 * deliberately exempt: sign-in remains a reattachment operation, not a new
 * account generation. Deleted or deleting links are compared only through a
 * short-lived, purpose-separated digest. The primary-D1 copy is checked here
 * for a clear user-facing result and enforced again by an INSERT trigger.
 */
async function assertIdentityReenrollmentAllowed(
  env: Env,
  identityLinkKey: string,
): Promise<string | null> {
  const state = await participantIdentityLinkState(
    env.USAGE_MONITOR_DB,
    identityLinkKey,
  );
  // Do not fall through to a fresh enrollment when the deletion still owns
  // the link. The caller must start a new verified handoff after deletion
  // reaches a stable outcome.
  if (state?.state === "deleting") {
    throw new ApiError(409, "PARTICIPANT_DELETING");
  }
  const rawIdentityLinkSecret = Reflect.get(env, "IDENTITY_LINK_SECRET");
  if (typeof rawIdentityLinkSecret !== "string"
      || rawIdentityLinkSecret.length < 32) {
    if (identityRequired(env)) {
      throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
    }
    return null;
  }
  // Derive even for an active row. A deletion may complete after this state
  // read and before reattachment; the value then reaches the atomic INSERT
  // guard if a fresh enrollment is attempted.
  const cooldownDigest = await identityReenrollmentCooldownDigest(
    rawIdentityLinkSecret,
    identityLinkKey,
  );
  if (state?.state === "active") return cooldownDigest;
  const [primaryCoolingDown, ledgerCoolingDown] = await Promise.all([
    hasIdentityReenrollmentCooldownDigest(
      env.USAGE_MONITOR_DB,
      cooldownDigest,
    ),
    hasIdentityReenrollmentCooldownDigest(
      env.DELETION_LEDGER,
      cooldownDigest,
    ),
  ]);
  if (primaryCoolingDown || ledgerCoolingDown) {
    throw new ApiError(409, "IDENTITY_REENROLLMENT_COOLDOWN");
  }
  return cooldownDigest;
}

/**
 * Real hosted callbacks verify the provider-signed ID token before reducing it
 * to the irreversible identity link key. The offline development harness has
 * no provider signing keys or network access, so it uses a deterministic
 * synthetic link key solely to exercise the state/PKCE/proof handoff. It
 * remains impossible for that path to accept a provider token at enrollment:
 * enrollment always requires the server-issued opaque proof above.
 */
async function verifiedHostedCallbackIdentity(
  env: Env,
  provider: "apple" | "google",
  idToken: string,
  options: { expectedNonceHash?: string } = {},
): Promise<{ provider: "apple" | "google"; linkKeyHex: string }> {
  if (identityRequired(env)) {
    return verifyHostedIdentity(env, { provider, idToken }, options);
  }
  return {
    provider,
    linkKeyHex: await sha256Hex(
      `app-usagemonitor/development-handoff/v1\0${provider}\0${idToken}`,
    ),
  };
}

const MAX_EXPIRED_SIGNIN_HANDOFFS_PER_PROVIDER = 100;

interface ExpiredIdentityHandoffPurge {
  purged: number;
  complete: boolean;
}

async function deleteExpiredAppleHandoffs(
  db: D1Database,
  nowIso: string,
  maximumRows = MAX_EXPIRED_SIGNIN_HANDOFFS_PER_PROVIDER,
): Promise<number> {
  return deleteExpiredAppleSignInHandoffs(db, nowIso, maximumRows);
}

async function deleteExpiredGoogleHandoffs(
  db: D1Database,
  nowIso: string,
  maximumRows = MAX_EXPIRED_SIGNIN_HANDOFFS_PER_PROVIDER,
): Promise<number> {
  const result = await db.prepare(
    `DELETE FROM google_signin_handoffs
      WHERE state IN (
        SELECT state FROM google_signin_handoffs
         WHERE expires_at <= ?
         ORDER BY expires_at, state
         LIMIT ?
      )`,
  ).bind(nowIso, maximumRows).run();
  return result.meta.changes;
}

/**
 * A provider can return a valid state with an explicit cancellation (or an
 * exchange can fail after that state has been claimed). That handoff cannot
 * subsequently succeed: authorization codes are one-time and the person has
 * already chosen a different outcome. Delete only an empty, live row so a
 * late cancellation can never undo a completed or delivered sign-in.
 */
async function discardPendingAppleHandoff(
  db: D1Database,
  state: string,
  nowIso: string,
): Promise<void> {
  await discardPendingAppleSignInHandoff(db, state, nowIso);
}

/**
 * Discards an unclaimed Google handoff after a provider cancellation that
 * arrives before any callback has claimed the row. The `claim_id IS NULL` fence
 * keeps a cancellation callback from deleting a row another callback is already
 * processing; that claimant discards its own row through
 * `discardClaimedGoogleHandoff`.
 */
async function discardPendingGoogleHandoff(
  db: D1Database,
  state: string,
  nowIso: string,
): Promise<void> {
  await db.prepare(
    `DELETE FROM google_signin_handoffs
      WHERE state = ?
        AND claim_id IS NULL
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?`,
  ).bind(state, nowIso).run();
}

/**
 * Discards a Google handoff the caller holds the claim on, after its own
 * provider exchange failed. Fenced to `claimId`, so a callback that lost its
 * claim to a lease-expiry re-claim deletes nothing.
 */
async function discardClaimedGoogleHandoff(
  db: D1Database,
  state: string,
  claimId: string,
  nowIso: string,
): Promise<void> {
  await db.prepare(
    `DELETE FROM google_signin_handoffs
      WHERE state = ?
        AND claim_id = ?
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?`,
  ).bind(state, claimId, nowIso).run();
}

async function hasExpiredAppleHandoffs(db: D1Database, nowIso: string): Promise<boolean> {
  return Boolean(await db.prepare(
    "SELECT 1 AS found FROM apple_signin_handoffs WHERE expires_at <= ? LIMIT 1",
  ).bind(nowIso).first<{ found: number }>());
}

async function hasExpiredGoogleHandoffs(db: D1Database, nowIso: string): Promise<boolean> {
  return Boolean(await db.prepare(
    "SELECT 1 AS found FROM google_signin_handoffs WHERE expires_at <= ? LIMIT 1",
  ).bind(nowIso).first<{ found: number }>());
}

async function purgeExpiredIdentityHandoffs(
  db: D1Database,
  nowIso: string,
): Promise<ExpiredIdentityHandoffPurge> {
  const [applePurged, googlePurged] = await Promise.all([
    deleteExpiredAppleHandoffs(db, nowIso),
    deleteExpiredGoogleHandoffs(db, nowIso),
  ]);
  const [appleRemaining, googleRemaining] = await Promise.all([
    applePurged === MAX_EXPIRED_SIGNIN_HANDOFFS_PER_PROVIDER
      ? hasExpiredAppleHandoffs(db, nowIso)
      : false,
    googlePurged === MAX_EXPIRED_SIGNIN_HANDOFFS_PER_PROVIDER
      ? hasExpiredGoogleHandoffs(db, nowIso)
      : false,
  ]);
  return {
    purged: applePurged + googlePurged,
    complete: !appleRemaining && !googleRemaining,
  };
}

function signInCallbackPage(
  message: string,
  { completed = false }: { completed?: boolean } = {},
): Response {
  // The page stays entirely self-contained: no script, external asset, or
  // request value reaches this markup. The authorization code, id_token,
  // Apple's optional user payload, state, and proof remain server-side. The
  // one fixed app link is both a graceful manual fallback and an automatic
  // return on a completed sign-in.
  const title = completed
    ? "You're signed in"
    : "Sign-in was not completed";
  const detail = completed
    ? "TiboTattle is opening now. You can close this browser tab."
    : "No data was uploaded. TiboTattle is reopening so you can try again.";
  // The app link is fixed and carries no provider material. Returning to the
  // app after either outcome prevents a failed callback from leaving the user
  // stranded in a browser tab while the dashboard continues to wait.
  const refresh = `<meta http-equiv="refresh" content="${completed ? "0" : "2"}; url=${SIGNIN_CALLBACK_APP_OPEN_URL}">`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}
<title>TiboTattle sign-in</title>
<style>
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { align-items: center; background: #f5f3ec; color: #16211d; display: flex; justify-content: center; margin: 0; min-height: 100vh; padding: 28px; }
main { background: #fffefa; border: 1px solid #d7d5cc; border-radius: 20px; box-shadow: 0 18px 54px rgba(24, 39, 32, .14); max-width: 34rem; padding: 38px; width: 100%; }
.brand { color: #176052; font-size: .78rem; font-weight: 750; letter-spacing: .12em; margin: 0 0 18px; text-transform: uppercase; }
h1 { font-family: ui-serif, Georgia, serif; font-size: clamp(2rem, 7vw, 3.1rem); letter-spacing: -.035em; line-height: 1.04; margin: 0 0 16px; }
p { color: #52625b; font-size: 1rem; line-height: 1.55; margin: 0; }
.action { background: #155f51; border-radius: 11px; color: #fff; display: inline-block; font-weight: 700; margin-top: 28px; padding: 13px 18px; text-decoration: none; }
.hint { color: #718078; font-size: .9rem; margin-top: 16px; }
@media (prefers-color-scheme: dark) { body { background: #16201d; color: #f5f4ed; } main { background: #202b27; border-color: #425048; box-shadow: none; } p { color: #c1cbc4; } .hint { color: #9dab9f; } }
</style>
</head>
<body>
<main>
<p class="brand">TiboTattle</p>
<h1>${title}</h1>
<p>${message}</p>
<p class="hint">${detail}</p>
<a class="action" href="${SIGNIN_CALLBACK_APP_OPEN_URL}">Open TiboTattle</a>
</main>
</body>
</html>
`;
  return new Response(html, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Starts a hosted Apple sign-in. The state row is the whole handoff: it is
 * created empty here, filled by Apple's callback, and read back exactly once
 * by the page that started the flow. No participant, session, or provider
 * identifier is involved at this point.
 */
async function handleIdentityAppleStart(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  assertSameOrigin(request);
  await assertHostedSignInStartAllowed(env);
  assertAdmissionBindings(env);
  await assertAttemptAllowed(
    env.ENROLLMENT_RATE_LIMIT,
    env.CLIENT_ATTEMPT_RATE_LIMIT,
    request,
    env,
    "sign_in_start",
  );
  const configuration = appleSignInConfiguration(env);
  const redirectUri = signInCallbackUrl(request, env, "apple");
  const body = await readBoundedJson(request);
  const value = body.value;
  // The initiating client supplies `binding` = SHA-256(verifier). The raw
  // verifier stays on the client and is required again to collect the result
  // and to consume the proof, so the state alone is never a bearer capability.
  const binding = Reflect.get(value ?? {}, "binding");
  if (typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || Object.keys(value).length !== 1
      || typeof binding !== "string"
      || !SIGNIN_HANDOFF_BINDING_PATTERN.test(binding)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  await assertSignInStartAdmission(env.USAGE_MONITOR_DB, env);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  await deleteExpiredAppleHandoffs(env.USAGE_MONITOR_DB, nowIso);
  // 48 random bytes render as 64 base64url characters.
  const state = randomSecret(48);
  const nonce = generateAppleSignInNonce();
  const nonceHash = await hashAppleSignInNonce(nonce);
  await insertAppleSignInHandoff(env.USAGE_MONITOR_DB, {
    state,
    nonceHash,
    bindingHash: binding,
    createdAt: nowIso,
    expiresAt: new Date(
      nowMs + SIGNIN_HANDOFF_AUTHORIZATION_TTL_MILLISECONDS,
    ).toISOString(),
  });
  return jsonResponse({
    schemaVersion: "identity-apple-start-v0.1",
    state,
    authorizeUrl: appleAuthorizeUrl(configuration, redirectUri, state, nonce),
  });
}

/**
 * Apple's form_post callback. This request is cross-site by construction — it
 * is a top-level form submission from appleid.apple.com — so same-origin
 * enforcement cannot apply. The unguessable state row is what authorizes it:
 * a request whose state is unknown, already filled, already consumed, or
 * expired is answered with a fixed page and nothing else happens, so an
 * unsolicited callback can neither mint a token exchange nor overwrite a
 * pending sign-in.
 */
async function handleIdentityAppleCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  const redirectUri = signInCallbackUrl(request, env, "apple");
  const form = await readBoundedForm(request, MAX_APPLE_CALLBACK_BYTES);
  const state = form.get("state");
  const code = form.get("code");
  const failure = signInCallbackPage(SIGNIN_NOT_COMPLETED_MESSAGE);
  if (typeof state !== "string"
      || !APPLE_SIGNIN_STATE_PATTERN.test(state)) {
    return failure;
  }
  const nowIso = new Date().toISOString();
  if (form.get("error") !== null) {
    await discardPendingAppleHandoff(env.USAGE_MONITOR_DB, state, nowIso);
    return failure;
  }
  if (typeof code !== "string" || code.length === 0) return failure;
  // Atomically reserve the row before any client-secret signing or provider I/O.
  // Of many callbacks carrying this one valid state, exactly one wins the claim;
  // the rest see no change here and stop, so provider work cannot fan out.
  const claimId = randomSecret(48);
  const pending = await claimPendingAppleSignInHandoff(
    env.USAGE_MONITOR_DB,
    state,
    claimId,
    nowIso,
    new Date(
      Date.now() - SIGNIN_HANDOFF_PROCESSING_LEASE_MILLISECONDS,
    ).toISOString(),
  );
  if (!pending) return failure;
  let verified: { provider: "apple" | "google"; linkKeyHex: string };
  try {
    if (identityRequired(env)) {
      await assertPinnedIdentityLinkSecretConfiguration(
        env.USAGE_MONITOR_DB,
        Reflect.get(env, "IDENTITY_LINK_SECRET"),
        Reflect.get(env, "IDENTITY_LINK_SECRET_VERSION"),
      );
    }
    const idToken = await exchangeAppleAuthorizationCode(env, code, redirectUri);
    verified = await verifiedHostedCallbackIdentity(env, "apple", idToken, {
      // The offline harness intentionally has no signed Apple token. Hosted
      // deployments always bind the signed nonce claim to this state row.
      expectedNonceHash: identityRequired(env) ? pending.nonceHash : undefined,
    });
  } catch {
    // A provider code can be spent only once. Leaving this handoff pending
    // would make the desktop app poll a state that cannot ever complete. The
    // discard is fenced to this callback's own claim, so a callback whose claim
    // was preempted by a lease-expiry re-claim can never delete the new
    // claimant's row.
    await discardClaimedAppleSignInHandoff(
      env.USAGE_MONITOR_DB,
      state,
      claimId,
      new Date().toISOString(),
    );
    return failure;
  }
  // The authorization deadline is re-checked against the time the exchange
  // finished, not the time it started, so a handoff that expired mid-exchange
  // is never filled. The same write moves the row into its delivery phase: the
  // proof being minted here gets its own full window, measured from now, so it
  // cannot expire between being minted and being collectable however long the
  // round trip took.
  const filledAtMs = Date.now();
  const stored = await completeAppleSignInHandoff(
    env.USAGE_MONITOR_DB,
    state,
    claimId,
    verified.linkKeyHex,
    randomSecret(48),
    new Date(filledAtMs).toISOString(),
    new Date(
      filledAtMs + SIGNIN_HANDOFF_DELIVERY_TTL_MILLISECONDS,
    ).toISOString(),
  );
  if (!stored) return failure;
  return signInCallbackPage(SIGNIN_COMPLETED_MESSAGE, { completed: true });
}

/**
 * Reads a completed sign-in back idempotently for the same state+verifier.
 * This releases a short-lived, opaque proof only; provider credentials never
 * leave the callback and never reach D1. Enrollment atomically deletes the
 * proof when it uses it, so result recovery ends at consumption or expiry.
 *
 * This route is deliberately not attempt-limited: the page polls it on a
 * fixed short schedule while the user finishes at Apple, and it discloses
 * nothing to anyone who does not already hold the unguessable state.
 */
async function handleIdentityAppleResult(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  assertSameOrigin(request);
  const body = await readBoundedJson(request);
  const value = body.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const state = Reflect.get(value, "state");
  const verifier = Reflect.get(value, "verifier");
  if (Object.keys(value).length !== 2
      || typeof state !== "string"
      || !APPLE_SIGNIN_STATE_PATTERN.test(state)
      || typeof verifier !== "string"
      || !SIGNIN_HANDOFF_VERIFIER_PATTERN.test(verifier)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const bindingHash = await sha256Hex(verifier);
  const nowIso = new Date().toISOString();
  await deleteExpiredAppleHandoffs(env.USAGE_MONITOR_DB, nowIso);
  const delivered = await deliverAppleSignInHandoff(
    env.USAGE_MONITOR_DB,
    state,
    nowIso,
    bindingHash,
  );
  if (delivered) {
    return jsonResponse({
      schemaVersion: "identity-apple-result-v0.1",
      proof: delivered.proof,
    });
  }
  const pending = await readPendingAppleSignInHandoff(
    env.USAGE_MONITOR_DB,
    state,
    nowIso,
    bindingHash,
  );
  if (pending) throw new ApiError(404, "IDENTITY_RESULT_PENDING");
  throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
}

/**
 * Starts a hosted Google sign-in, in the same shape as Apple's: the state row
 * is the whole handoff. It is created empty here with its PKCE verifier,
 * filled by Google's redirect, and read back by the page that started the
 * flow until enrollment consumes it. No participant, session, or provider identifier is
 * involved at this point, and the verifier never leaves this service.
 */
async function handleIdentityGoogleStart(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  assertSameOrigin(request);
  await assertHostedSignInStartAllowed(env);
  assertAdmissionBindings(env);
  await assertAttemptAllowed(
    env.ENROLLMENT_RATE_LIMIT,
    env.CLIENT_ATTEMPT_RATE_LIMIT,
    request,
    env,
    "sign_in_start",
  );
  const configuration = googleSignInConfiguration(env);
  const redirectUri = signInCallbackUrl(request, env, "google");
  const body = await readBoundedJson(request);
  const value = body.value;
  // `binding` = SHA-256(client verifier). It is server-held PKCE-independent:
  // the `code_verifier` below authenticates the Worker's own token exchange,
  // whereas this binding authenticates the client that may collect and consume
  // the result. The two are never conflated.
  const binding = Reflect.get(value ?? {}, "binding");
  if (typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || Object.keys(value).length !== 1
      || typeof binding !== "string"
      || !SIGNIN_HANDOFF_BINDING_PATTERN.test(binding)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  await assertSignInStartAdmission(env.USAGE_MONITOR_DB, env);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  await deleteExpiredGoogleHandoffs(env.USAGE_MONITOR_DB, nowIso);
  // 48 random bytes render as 64 base64url characters, which satisfies both
  // the state pattern and RFC 7636's 43-128 character verifier range.
  const state = randomSecret(48);
  const codeVerifier = randomSecret(48);
  await env.USAGE_MONITOR_DB.prepare(
    `INSERT INTO google_signin_handoffs
       (state, code_verifier, binding_hash, identity_link_key, proof, created_at, expires_at, delivered_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL)`,
  ).bind(
    state,
    codeVerifier,
    binding,
    nowIso,
    new Date(
      nowMs + SIGNIN_HANDOFF_AUTHORIZATION_TTL_MILLISECONDS,
    ).toISOString(),
  ).run();
  return jsonResponse({
    schemaVersion: "identity-google-start-v0.1",
    state,
    authorizeUrl: googleAuthorizeUrl(
      configuration,
      redirectUri,
      state,
      await googleCodeChallenge(codeVerifier),
    ),
  });
}

/**
 * Google's redirect callback. Like Apple's, this request is cross-site by
 * construction — it is a top-level navigation from accounts.google.com — so
 * same-origin enforcement cannot apply. The unguessable state row is what
 * authorizes it: a request whose state is unknown, already filled, already
 * consumed, or expired is answered with a fixed page and nothing else happens,
 * so an unsolicited callback can neither mint a token exchange nor overwrite a
 * pending sign-in. The PKCE verifier is read from that same row, so a callback
 * that did not come from a start this service issued has no verifier to spend.
 */
async function handleIdentityGoogleCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  const redirectUri = signInCallbackUrl(request, env, "google");
  const failure = signInCallbackPage(SIGNIN_NOT_COMPLETED_MESSAGE);
  if (request.url.length > MAX_GOOGLE_CALLBACK_URL_LENGTH) return failure;
  const parameters = new URL(request.url).searchParams;
  const state = parameters.get("state");
  const code = parameters.get("code");
  if (typeof state !== "string"
      || !GOOGLE_SIGNIN_STATE_PATTERN.test(state)) {
    return failure;
  }
  const nowIso = new Date().toISOString();
  if (parameters.get("error") !== null) {
    await discardPendingGoogleHandoff(env.USAGE_MONITOR_DB, state, nowIso);
    return failure;
  }
  if (typeof code !== "string" || code.length === 0) return failure;
  // Atomically reserve the row before spending the PKCE verifier on a provider
  // token request. The same conditional UPDATE that claims the row returns the
  // verifier, so exactly one of many racing callbacks reaches the exchange; the
  // rest change no row and stop. `claimed_at <= staleBefore` permits one bounded
  // retry after a crashed claimant's lease expires.
  const claimId = randomSecret(48);
  const staleClaimBeforeIso = new Date(
    Date.now() - SIGNIN_HANDOFF_PROCESSING_LEASE_MILLISECONDS,
  ).toISOString();
  const pending = await env.USAGE_MONITOR_DB.prepare(
    `UPDATE google_signin_handoffs
        SET claim_id = ?, claimed_at = ?
      WHERE state = ?
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?
        AND (claim_id IS NULL OR claimed_at <= ?)
      RETURNING code_verifier AS codeVerifier`,
  ).bind(claimId, nowIso, state, nowIso, staleClaimBeforeIso)
    .first<{ codeVerifier: string }>();
  if (!pending) return failure;
  let verified: { provider: "apple" | "google"; linkKeyHex: string };
  try {
    if (identityRequired(env)) {
      await assertPinnedIdentityLinkSecretConfiguration(
        env.USAGE_MONITOR_DB,
        Reflect.get(env, "IDENTITY_LINK_SECRET"),
        Reflect.get(env, "IDENTITY_LINK_SECRET_VERSION"),
      );
    }
    const idToken = await exchangeGoogleAuthorizationCode(
      env,
      code,
      pending.codeVerifier,
      redirectUri,
    );
    verified = await verifiedHostedCallbackIdentity(env, "google", idToken);
  } catch {
    // A provider code can be spent only once. Leaving this handoff pending
    // would make the desktop app poll a state that cannot ever complete. The
    // discard is fenced to this callback's own claim, so a preempted callback
    // can never delete the row the new claimant is processing.
    await discardClaimedGoogleHandoff(
      env.USAGE_MONITOR_DB,
      state,
      claimId,
      new Date().toISOString(),
    );
    return failure;
  }
  // The authorization deadline is re-checked against the time the exchange
  // finished, not the time it started, so a handoff that expired mid-exchange
  // is never filled. The same write moves the row into its delivery phase on
  // Apple's terms: `expires_at` becomes the proof's own window, measured from
  // the instant the proof is minted. SQLite evaluates the WHERE clause against
  // the pre-update row, so the authorization deadline is still the one being
  // enforced here.
  const filledAtMs = Date.now();
  // Completion is fenced to this claim: a callback whose claim was preempted by
  // a lease-expiry re-claim writes zero rows and reports failure.
  const stored = await env.USAGE_MONITOR_DB.prepare(
    `UPDATE google_signin_handoffs
        SET code_verifier = NULL, identity_link_key = ?, proof = ?, expires_at = ?
      WHERE state = ?
        AND claim_id = ?
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?`,
  ).bind(
    verified.linkKeyHex,
    randomSecret(48),
    new Date(filledAtMs + SIGNIN_HANDOFF_DELIVERY_TTL_MILLISECONDS).toISOString(),
    state,
    claimId,
    new Date(filledAtMs).toISOString(),
  ).run();
  if (stored.meta.changes !== 1) return failure;
  return signInCallbackPage(SIGNIN_COMPLETED_MESSAGE, { completed: true });
}

/**
 * Reads the completed Google sign-in back idempotently for the same
 * state+verifier, on the same opaque proof terms as Apple's result route.
 *
 * This route is deliberately not attempt-limited: the page polls it on a fixed
 * short schedule while the user finishes at Google, and it discloses nothing
 * to anyone who does not already hold the unguessable state.
 */
async function handleIdentityGoogleResult(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  assertSameOrigin(request);
  const body = await readBoundedJson(request);
  const value = body.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const state = Reflect.get(value, "state");
  const verifier = Reflect.get(value, "verifier");
  if (Object.keys(value).length !== 2
      || typeof state !== "string"
      || !GOOGLE_SIGNIN_STATE_PATTERN.test(state)
      || typeof verifier !== "string"
      || !SIGNIN_HANDOFF_VERIFIER_PATTERN.test(verifier)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const bindingHash = await sha256Hex(verifier);
  const nowIso = new Date().toISOString();
  await deleteExpiredGoogleHandoffs(env.USAGE_MONITOR_DB, nowIso);
  // The proof is released only to a caller re-presenting the initiator's
  // verifier: a mismatched or absent binding updates zero rows, so the proof is
  // neither delivered nor consumed and stays collectable by the initiator.
  const delivered = await env.USAGE_MONITOR_DB.prepare(
    `UPDATE google_signin_handoffs
        SET delivered_at = COALESCE(delivered_at, ?)
      WHERE state = ?
        AND binding_hash = ?
        AND identity_link_key IS NOT NULL
        AND proof IS NOT NULL
        AND expires_at > ?
      RETURNING proof`,
  ).bind(nowIso, state, bindingHash, nowIso).first<{ proof: string }>();
  if (delivered) {
    return jsonResponse({
      schemaVersion: "identity-google-result-v0.1",
      proof: delivered.proof,
    });
  }
  // A caller holding the state but not the verifier cannot even learn that a
  // sign-in is pending: the binding is required here too.
  const pending = await env.USAGE_MONITOR_DB.prepare(
    `SELECT state FROM google_signin_handoffs
      WHERE state = ?
        AND binding_hash = ?
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?`,
  ).bind(state, bindingHash, nowIso).first<{ state: string }>();
  if (pending) throw new ApiError(404, "IDENTITY_RESULT_PENDING");
  throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
}

/**
 * Apple now records a Services ID's web domain and callback in its portal; it
 * does not fetch a server association file. This historical filename stays
 * worker-first solely to prevent SPA fallback from returning index.html with a
 * misleading 200 response. It is not configuration and never a release gate.
 */
function handleRetiredAppleDomainAssociation(): never {
  throw new ApiError(404, "NOT_FOUND");
}

async function handleRecover(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  assertSameOrigin(request);
  configuredEnrollmentMode(env);
  if (identityRequired(env)) {
    // Hosted identity is mandatory outside development: signing in again
    // reattaches the same participant, replacing the recovery-code flow.
    throw new ApiError(401, "IDENTITY_REQUIRED");
  }
  assertAdmissionBindings(env);
  await assertAttemptAllowed(
    env.RECOVERY_RATE_LIMIT,
    env.CLIENT_ATTEMPT_RATE_LIMIT,
    request,
    env,
    "recovery",
  );
  const body = await readBoundedJson(request);
  if (typeof body.value !== "object"
    || body.value === null
    || Array.isArray(body.value)
    || Object.keys(body.value).length !== 2
    || !Object.hasOwn(body.value, "recoveryCode")
    || !Object.hasOwn(body.value, "recoveryAttemptId")) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const recovered = await recoverAccess(
    env.USAGE_MONITOR_DB,
    Reflect.get(body.value, "recoveryCode"),
    Reflect.get(body.value, "recoveryAttemptId"),
  );
  return jsonResponse({
    participantId: recovered.participantId,
    csrfToken: recovered.csrfToken,
    recoveryCode: recovered.recoveryCode,
    consentVersion: recovered.consentVersion,
  }, 200, { "set-cookie": sessionCookie(recovered.session) });
}

async function personalSession(
  request: Request,
  env: Env,
  allowDeleting = false,
  allowDeletionOnly = false,
): Promise<SessionPrincipal> {
  if (request.headers.has("authorization")) throw new ApiError(401, "AUTH_INVALID");
  const session = await authenticateSession(
    env.USAGE_MONITOR_DB,
    request.headers.get("cookie"),
    { allowDeleting, allowDeletionOnly },
  );
  if (!allowDeleting
      && await hasDeletionTombstone(env.DELETION_LEDGER, session.participantId)) {
    throw new ApiError(401, "AUTH_INVALID");
  }
  return session;
}

async function handleSession(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  const session = await personalSession(request, env);
  return jsonResponse({
    participantId: session.participantId,
    createdAt: session.participantCreatedAt,
    expiresAt: session.expiresAt,
    csrfToken: session.csrfToken,
    consentVersion: session.consentVersion,
  }, 200, { vary: "Cookie" });
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  let session: SessionPrincipal;
  try {
    session = await personalSession(request, env);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error;
    return jsonResponse(
      { loggedOut: true },
      200,
      { "set-cookie": clearedSessionCookie(), vary: "Cookie" },
    );
  }
  assertCsrf(request, session);
  await revokeSession(env.USAGE_MONITOR_DB, session.participantId, session.sessionId);
  return jsonResponse(
    { loggedOut: true },
    200,
    { "set-cookie": clearedSessionCookie(), vary: "Cookie" },
  );
}

async function handleSecurityReset(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  const session = await personalSession(request, env);
  assertCsrf(request, session);
  const result = await securityReset(
    env.USAGE_MONITOR_DB,
    session.participantId,
    session.sessionId,
  );
  return jsonResponse({
    reset: true,
    recoveryCode: result.recoveryCode,
    csrfToken: session.csrfToken,
    consentVersion: session.consentVersion,
  }, 200, { vary: "Cookie" });
}

async function handleUploadAuthorization(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  assertAdmissionBindings(env);
  assertUploadAuthorizationBindings(env);
  assertUploadIngressConfiguration(env);
  await assertCollectionControl(
    env.USAGE_MONITOR_DB,
    "uploadRegistration",
  );
  const session = await personalSession(request, env);
  assertCsrf(request, session);
  await assertUploadAuthorizationAllowed(
    env.UPLOAD_AUTHORIZATION_RATE_LIMIT,
    env.UPLOAD_PRINCIPAL_RATE_LIMIT,
    session.participantId,
    env,
  );
  await probeUploadIngressBudget(env);
  const body = await readBoundedJson(request);
  if (typeof body.value !== "object"
      || body.value === null
      || Array.isArray(body.value)
      || Object.keys(body.value).length !== 3
      || typeof Reflect.get(body.value, "envelopeDigest") !== "string"
      || !/^[0-9a-f]{64}$/u.test(Reflect.get(body.value, "envelopeDigest") as string)
      || !Number.isSafeInteger(Reflect.get(body.value, "contentLengthBytes"))
      || (Reflect.get(body.value, "contentLengthBytes") as number) <= 0
      || (Reflect.get(body.value, "contentLengthBytes") as number) > MAX_REQUEST_BYTES
      || Reflect.get(body.value, "contentType") !== "application/json") {
    throw new ApiError(400, "BODY_INVALID");
  }
  const authorization = await createUploadAuthorizationMaterial(
    session.participantId,
    session.sessionId,
    Reflect.get(body.value, "envelopeDigest") as string,
    Reflect.get(body.value, "contentLengthBytes") as number,
  );
  await storeUploadAuthorization(env.USAGE_MONITOR_DB, authorization);
  return jsonResponse({
    uploadAuthorization: authorization.encoded,
    expiresAt: authorization.expiresAt,
  }, 201, { vary: "Cookie" });
}

async function handleDevicePairing(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  await assertCollectionControl(
    env.USAGE_MONITOR_DB,
    "uploadRegistration",
  );
  const session = await personalSession(request, env);
  assertCsrf(request, session);
  const accountScoped = session.consentVersion
    === ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION;
  if (accountScoped) {
    assertAccountScopedLocalPreview(request, env);
  } else if (session.consentVersion !== TELEMETRY_CONSENT_VERSION) {
    throw new ApiError(400, "TELEMETRY_REQUIRED");
  }
  const body = await readBoundedJson(request);
  const requestedConsentVersion = Reflect.get(body.value ?? {}, "consentVersion");
  // A telemetry participant may request either the deployed v0.1 ongoing
  // consent or the v1.0 incremental-contribution consent; the account-scoped
  // preview keeps its own single identifier. The pairing records the choice
  // server-side, which is what the v1.0 chunk path later verifies against.
  const allowedConsentVersions = accountScoped
    ? [ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION]
    : [
      ONGOING_TELEMETRY_CONSENT_VERSION,
      ONGOING_INCREMENTAL_TELEMETRY_CONSENT_VERSION,
    ];
  if (typeof body.value !== "object"
      || body.value === null
      || Array.isArray(body.value)
      || Object.keys(body.value).length !== 2
      || typeof requestedConsentVersion !== "string"
      || !allowedConsentVersions.includes(requestedConsentVersion)
      || Reflect.get(body.value, "ongoingUpload") !== true) {
    throw new ApiError(400, "BODY_INVALID");
  }
  return jsonResponse(
    await createDevicePairing(
      env.USAGE_MONITOR_DB,
      session.participantId,
      session.sessionId,
      session.consentVersion,
      undefined,
      undefined,
      requestedConsentVersion as DeviceTransportConsentVersion,
    ),
    201,
    { vary: "Cookie" },
  );
}

async function handleDevicePairingClaim(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  await assertCollectionControl(
    env.USAGE_MONITOR_DB,
    "uploadRegistration",
  );
  if (request.headers.has("cookie")) throw new ApiError(401, "PAIRING_AUTH_INVALID");
  const body = await readBoundedJson(request);
  if (typeof body.value !== "object"
      || body.value === null
      || Array.isArray(body.value)
      || Object.keys(body.value).length !== 2
      || typeof Reflect.get(body.value, "deviceId") !== "string"
      || typeof Reflect.get(body.value, "deviceSecretHash") !== "string") {
    throw new ApiError(400, "BODY_INVALID");
  }
  return jsonResponse(await claimDevicePairing(
    env.USAGE_MONITOR_DB,
    request.headers.get("authorization"),
    Reflect.get(body.value, "deviceId") as string,
    Reflect.get(body.value, "deviceSecretHash") as string,
  ), 201);
}

async function handleDeviceUploadAuthorization(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  assertAdmissionBindings(env);
  assertUploadAuthorizationBindings(env);
  assertUploadIngressConfiguration(env);
  await assertCollectionControl(
    env.USAGE_MONITOR_DB,
    "uploadRegistration",
  );
  if (request.headers.has("cookie")) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  const device = await authenticateDevice(
    env.USAGE_MONITOR_DB,
    request.headers.get("authorization"),
  );
  if (await hasDeletionTombstone(env.DELETION_LEDGER, device.participantId)) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  await assertUploadAuthorizationAllowed(
    env.UPLOAD_AUTHORIZATION_RATE_LIMIT,
    env.UPLOAD_PRINCIPAL_RATE_LIMIT,
    device.participantId,
    env,
  );
  await probeUploadIngressBudget(env);
  const body = await readBoundedJson(request);
  if (typeof body.value !== "object"
      || body.value === null
      || Array.isArray(body.value)
      || Object.keys(body.value).length !== 3
      || typeof Reflect.get(body.value, "envelopeDigest") !== "string"
      || !/^[0-9a-f]{64}$/u.test(Reflect.get(body.value, "envelopeDigest") as string)
      || !Number.isSafeInteger(Reflect.get(body.value, "contentLengthBytes"))
      || (Reflect.get(body.value, "contentLengthBytes") as number) <= 0
      || (Reflect.get(body.value, "contentLengthBytes") as number) > MAX_REQUEST_BYTES
      || Reflect.get(body.value, "contentType") !== "application/json") {
    throw new ApiError(400, "BODY_INVALID");
  }
  return jsonResponse(await createDeviceUploadAuthorization(
    env.USAGE_MONITOR_DB,
    device,
    Reflect.get(body.value, "envelopeDigest") as string,
    Reflect.get(body.value, "contentLengthBytes") as number,
  ), 201);
}

/**
 * Let the Mac that holds an upload-only bearer stop itself even while public
 * collection is contained. This deliberately does not use a browser cookie,
 * CSRF token, or the upload-registration control: the presented device secret
 * is the sole authority and a stopped client must always be able to revoke
 * it. It is idempotent for a valid credential and revokes pending uploads too.
 */
async function handleDeviceDisconnect(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  // This endpoint intentionally accepts a device bearer without a browser
  // session so a Mac can stop itself during a collection incident. Apply the
  // existing coarse/per-client admission before the credential hash and D1
  // lookup, so arbitrary plausible bearers cannot turn revocation into an
  // unbounded public work amplifier.
  assertAdmissionBindings(env);
  await assertAttemptAllowed(
    env.RECOVERY_RATE_LIMIT,
    env.CLIENT_ATTEMPT_RATE_LIMIT,
    request,
    env,
    "device_disconnect",
  );
  if (request.headers.has("cookie")) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  if (request.headers.get("content-length") !== null
      && request.headers.get("content-length") !== "0") {
    throw new ApiError(400, "BODY_INVALID");
  }
  const disconnected = await disconnectAuthenticatedDevice(
    env.USAGE_MONITOR_DB,
    request.headers.get("authorization"),
  );
  return jsonResponse({
    schemaVersion: "device-disconnect-v0.1",
    disconnected: true,
    deviceId: disconnected.deviceId,
  });
}

/**
 * Silent auto-renewal. A valid, unexpired device bearer rotates its own secret
 * in place: the client presents the current device credential (device auth, no
 * browser session) plus the hash of a freshly generated replacement secret and
 * an idempotent attempt id. The service atomically supersedes the old secret
 * for the SAME device — never a new slot, so it stays compatible with the
 * active-device cap and its self-heal — and returns the new expiry. This keeps
 * the 30-day credential from ever lapsing under normal use with zero user
 * interaction. `rotateDeviceCredential` enforces the same idle window and the
 * hard social-recheck horizon that a sliding auth does, so renewal can extend
 * the bearer but never past the deadline that legitimately requires a re-login.
 */
async function handleDeviceCredentialRenew(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  assertAdmissionBindings(env);
  await assertAttemptAllowed(
    env.RECOVERY_RATE_LIMIT,
    env.CLIENT_ATTEMPT_RATE_LIMIT,
    request,
    env,
    "device_credential_renew",
  );
  await assertCollectionControl(
    env.USAGE_MONITOR_DB,
    "uploadRegistration",
  );
  if (request.headers.has("cookie")) throw new ApiError(401, "DEVICE_AUTH_INVALID");
  const body = await readBoundedJson(request);
  if (typeof body.value !== "object"
      || body.value === null
      || Array.isArray(body.value)
      || Object.keys(body.value).length !== 2
      || typeof Reflect.get(body.value, "nextDeviceSecretHash") !== "string"
      || typeof Reflect.get(body.value, "rotationAttemptId") !== "string") {
    throw new ApiError(400, "BODY_INVALID");
  }
  const rotated = await rotateDeviceCredential(
    env.USAGE_MONITOR_DB,
    request.headers.get("authorization"),
    Reflect.get(body.value, "nextDeviceSecretHash") as string,
    Reflect.get(body.value, "rotationAttemptId") as string,
  );
  return jsonResponse({
    schemaVersion: "device-credential-renewal-v1.0",
    deviceId: rotated.deviceId,
    state: rotated.state,
    scope: rotated.scope,
    expiresAt: rotated.expiresAt,
    credentialGeneration: rotated.credentialGeneration,
    commit: rotated.commit,
  });
}

async function handleDevices(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  const session = await personalSession(request, env);
  return jsonResponse({
    devices: await listParticipantDevices(
      env.USAGE_MONITOR_DB,
      session.participantId,
    ),
  }, 200, { vary: "Cookie" });
}

async function handleDeviceRevocation(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  const session = await personalSession(request, env);
  assertCsrf(request, session);
  const body = await readBoundedJson(request);
  if (typeof body.value !== "object"
      || body.value === null
      || Array.isArray(body.value)
      || Object.keys(body.value).length !== 1
      || typeof Reflect.get(body.value, "deviceId") !== "string") {
    throw new ApiError(400, "BODY_INVALID");
  }
  const deviceId = Reflect.get(body.value, "deviceId") as string;
  if (!await revokeParticipantDevice(
    env.USAGE_MONITOR_DB,
    session.participantId,
    deviceId,
  )) {
    throw new ApiError(404, "DEVICE_NOT_FOUND");
  }
  return jsonResponse({ revoked: true, deviceId }, 200, { vary: "Cookie" });
}

function handleEnvelopeKey(request: Request, env: Env): Response {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  return jsonResponse(publicEnvelopeKey(env.ENVELOPE_PUBLIC_JWK));
}

async function handleSyntheticContribution(
  body: { raw: string; value: unknown },
  participant: { id: string; consentVersion: string },
  uploadAuthorization: {
    authorizationId: string;
    authorizationKind: "session" | "device";
  },
  env: Env,
): Promise<Response> {
  if (participant.consentVersion !== "synthetic-preview-v0.1") {
    throw new ApiError(400, "SYNTHETIC_REQUIRED");
  }
  const envelope = validateEnvelope(body.value);
  const digest = await envelopeDigest(envelope);
  const existing = await existingContribution(env.USAGE_MONITOR_DB, participant.id, digest);
  if (existing) {
    return jsonResponse(
      { contributionId: existing.id, status: existing.status },
      202,
      { "idempotency-replayed": "true" },
    );
  }
  if (await contributionCount(env.USAGE_MONITOR_DB, participant.id)
      >= MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT) {
    throw new ApiError(429, "CONTRIBUTION_LIMIT_REACHED");
  }

  const plaintext = await decryptSyntheticEnvelope(
    envelope,
    env.ENVELOPE_PUBLIC_JWK,
    env.ENVELOPE_PRIVATE_JWK,
  );
  const record = validateSyntheticContribution(plaintext);
  const contributionId = `contribution:${crypto.randomUUID()}`;
  const r2Key = `synthetic/${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();

  await putTrackedQuarantineObject(
    env.USAGE_MONITOR_DB,
    env.QUARANTINE,
    {
      contributionId,
      objectKind: "synthetic",
      r2Key,
      registeredAt: createdAt,
    },
    JSON.stringify(envelope),
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        contributionId,
        schemaVersion: envelope.schemaVersion,
        synthetic: "true",
      },
    },
  );
  try {
    await insertContribution(
      env.USAGE_MONITOR_DB,
      participant.id,
      uploadAuthorization,
      contributionId,
      r2Key,
      digest,
      envelope,
      record,
      createdAt,
    );
  } catch (error) {
    await env.QUARANTINE.delete(r2Key);
    await clearPendingQuarantineObject(env.USAGE_MONITOR_DB, {
      contributionId,
      r2Key,
    });
    const replay = await existingContribution(env.USAGE_MONITOR_DB, participant.id, digest);
    if (replay) {
      return jsonResponse(
        { contributionId: replay.id, status: replay.status },
        202,
        { "idempotency-replayed": "true" },
      );
    }
    if (await contributionCount(env.USAGE_MONITOR_DB, participant.id)
        >= MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT) {
      throw new ApiError(429, "CONTRIBUTION_LIMIT_REACHED");
    }
    throw error;
  }
  return jsonResponse(
    { contributionId, status: "accepted_synthetic" },
    202,
  );
}

async function handleTelemetryContribution(
  request: Request,
  body: { raw: string; value: unknown },
  participant: { id: string; consentVersion: string },
  uploadAuthorization: {
    authorizationId: string;
    authorizationKind: "session" | "device";
  },
  env: Env,
): Promise<Response> {
  const accountScoped = participant.consentVersion
    === ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION;
  if (accountScoped) {
    assertAccountScopedLocalPreview(request, env);
  } else if (participant.consentVersion !== TELEMETRY_CONSENT_VERSION) {
    throw new ApiError(400, "TELEMETRY_REQUIRED");
  }
  const envelope = validateTelemetryEnvelope(body.value);
  const envelopeDigestValue = await telemetryEnvelopeDigest(envelope);
  const envelopeReplay = await existingTelemetryContribution(
    env.USAGE_MONITOR_DB,
    participant.id,
    envelopeDigestValue,
    "envelope",
  );
  if (envelopeReplay) {
    const metadata = telemetryContributionMetadata(envelopeReplay) as {
      recordCounts: unknown;
    };
    return jsonResponse(
      {
        contributionId: envelopeReplay.id,
        status: envelopeReplay.status,
        replayed: true,
        recordCounts: metadata.recordCounts,
        accountingVerification: "server_repriced",
      },
      202,
      { "idempotency-replayed": "true" },
    );
  }
  const admission = await telemetryContributionAdmission(
    env.USAGE_MONITOR_DB,
    participant.id,
  );
  if (admission.state === "exhausted") {
    throw telemetryContributionLimitError(admission);
  }

  const plaintext = await decryptSyntheticEnvelope(
    envelope,
    env.ENVELOPE_PUBLIC_JWK,
    env.ENVELOPE_PRIVATE_JWK,
  );
  const record = accountScoped
    ? validateTelemetryContributionV02(plaintext)
    : validateTelemetryContribution(plaintext);
  const plaintextDigest = await telemetryPlaintextDigest(record);
  const contentReplay = await existingTelemetryContribution(
    env.USAGE_MONITOR_DB,
    participant.id,
    plaintextDigest,
  );
  if (contentReplay) {
    const metadata = telemetryContributionMetadata(contentReplay) as {
      recordCounts: unknown;
    };
    return jsonResponse(
      {
        contributionId: contentReplay.id,
        status: contentReplay.status,
        replayed: true,
        recordCounts: metadata.recordCounts,
        accountingVerification: "server_repriced",
      },
      202,
      { "idempotency-replayed": "true" },
    );
  }

  const contributionId = `contribution:${crypto.randomUUID()}`;
  const r2Key = `telemetry/${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  await putTrackedQuarantineObject(
    env.USAGE_MONITOR_DB,
    env.QUARANTINE,
    {
      contributionId,
      objectKind: "telemetry",
      r2Key,
      registeredAt: createdAt,
    },
    JSON.stringify(envelope),
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        contributionId,
        schemaVersion: envelope.schemaVersion,
        plaintextSchemaVersion: record.schemaVersion,
        synthetic: "false",
      },
    },
  );
  try {
    const result = accountScoped
      ? await insertTelemetryContributionV02(
        env.USAGE_MONITOR_DB,
        {
          participantId: participant.id,
          uploadAuthorizationId: uploadAuthorization.authorizationId,
          uploadAuthorizationKind: uploadAuthorization.authorizationKind,
          contributionId,
          r2Key,
          envelopeDigest: envelopeDigestValue,
          receivedAt: createdAt,
          plaintext: record,
        },
      )
      : await insertTelemetryContribution(
        env.USAGE_MONITOR_DB,
        participant.id,
        uploadAuthorization,
        contributionId,
        r2Key,
        envelopeDigestValue,
        plaintextDigest,
        record as ReturnType<typeof validateTelemetryContribution>,
        createdAt,
      );
    return jsonResponse({
      contributionId,
      status: accountScoped
        ? "accepted_account_scoped_local_preview"
        : "accepted",
      recordCounts: {
        usageEvents: record.usageEvents.length,
        quotaSnapshots: record.quotaSnapshots.length,
        activityMarkers: record.activityMarkers.length,
        accepted: result.acceptedRecords,
        deduplicated: result.deduplicatedRecords,
      },
      accountingVerification: "server_repriced",
    }, 202);
  } catch (error) {
    // The ingest batch can have committed before a later accounting write
    // fails. Look up the canonical row before any cleanup: a found row makes
    // this an indeterminate, committed outcome, so ordinary retention is the
    // only destructive cleanup path.
    const replay = await existingTelemetryContribution(
      env.USAGE_MONITOR_DB,
      participant.id,
      plaintextDigest,
    );
    if (replay) {
      const metadata = telemetryContributionMetadata(replay) as {
        recordCounts: unknown;
      };
      return jsonResponse(
        {
          contributionId: replay.id,
          status: replay.status,
          replayed: true,
          recordCounts: metadata.recordCounts,
          accountingVerification: "server_repriced",
        },
        202,
        { "idempotency-replayed": "true" },
      );
    }
    // A completed lookup with no row proves this request did not create a
    // retained contribution. Remove its orphan immediately. If either cleanup
    // operation fails, keep the pending registration so reconciliation can
    // remove the object later instead of treating that storage failure as
    // permission to lose a committed envelope.
    try {
      await env.QUARANTINE.delete(r2Key);
      await clearPendingQuarantineObject(env.USAGE_MONITOR_DB, {
        contributionId,
        r2Key,
      });
    } catch {
      // The reconciliation registration remains durable by design.
    }
    const retryAdmission = await telemetryContributionAdmission(
      env.USAGE_MONITOR_DB,
      participant.id,
    );
    if (retryAdmission.state === "exhausted") {
      throw telemetryContributionLimitError(retryAdmission);
    }
    throw error;
  }
}

async function telemetryV1ChunkReceipt(
  env: Env,
  row: TelemetryV1ChunkRow,
  deviceId: string,
): Promise<Response> {
  const acknowledgedThroughDay = await telemetryV1AcknowledgedThroughDay(
    env.USAGE_MONITOR_DB,
    row.participant_id,
    deviceId,
  );
  return jsonResponse(
    {
      schemaVersion: "telemetry-chunk-receipt-v1.0",
      contributionId: row.id,
      chunkId: telemetryV1ChunkId(row),
      chunkRevision: row.revision,
      status: row.superseded_at === null ? "accepted" : "superseded",
      replayed: true,
      recordCounts: {
        declared: row.record_count,
        accepted: row.accepted_record_count,
      },
      acknowledgedThroughDay,
    },
    202,
    { "idempotency-replayed": "true" },
  );
}

/**
 * telemetry-contribution-v1.0 incremental chunk ingest. Additive alongside
 * the deployed v0.1 prepared-sample path: v1.0 envelopes carry their own
 * schema version, so the v0.1 branch is untouched. Chunks are
 * device-authenticated only — the cursor is keyed (participant, device) and
 * a browser session has no device identity.
 */
async function handleTelemetryV1Contribution(
  body: { raw: string; value: unknown },
  participant: { id: string; consentVersion: string },
  uploadAuthorization: {
    authorizationId: string;
    authorizationKind: "session" | "device";
  },
  env: Env,
): Promise<Response> {
  if (uploadAuthorization.authorizationKind !== "device") {
    throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  }
  if (participant.consentVersion !== TELEMETRY_CONSENT_VERSION) {
    throw new ApiError(400, "TELEMETRY_REQUIRED");
  }
  const envelope = validateTelemetryV1Envelope(body.value);
  const envelopeDigestValue = await telemetryEnvelopeDigest(envelope);
  const deviceId = await telemetryV1DeviceForUploadAuthorization(
    env.USAGE_MONITOR_DB,
    uploadAuthorization.authorizationId,
  );
  if (deviceId === null) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  const envelopeReplay = await existingTelemetryV1ChunkByEnvelopeDigest(
    env.USAGE_MONITOR_DB,
    participant.id,
    envelopeDigestValue,
  );
  if (envelopeReplay) {
    return telemetryV1ChunkReceipt(env, envelopeReplay, deviceId);
  }

  const plaintext = await decryptSyntheticEnvelope(
    envelope,
    env.ENVELOPE_PUBLIC_JWK,
    env.ENVELOPE_PRIVATE_JWK,
  );
  const chunk = parseTelemetryV1Chunk(plaintext);
  // Consent once, granted server-side: the chunk's declared consent must
  // equal the currently required identifiers AND the grant this device's
  // pairing claim recorded. An upload can never create or repair the grant.
  assertTelemetryV1ConsentCurrent(chunk.consent);
  if (!await telemetryV1DeviceConsentCurrent(
    env.USAGE_MONITOR_DB,
    participant.id,
    deviceId,
  )) {
    throw new ApiError(403, "TELEMETRY_CONSENT_INVALID");
  }
  // The digest identity is the canonical minified JSON array of the chunk's
  // records — the same serialization the client computes — so replay and
  // supersession compare content, not envelope bytes.
  const canonicalRecords = canonicalJson(chunk.records);
  if (new TextEncoder().encode(canonicalRecords).byteLength
      > MAX_TELEMETRY_V1_CHUNK_CANONICAL_BYTES) {
    throw new ApiError(400, "CHUNK_INVALID");
  }
  if (await sha256Hex(canonicalRecords) !== chunk.chunkDigest) {
    throw new ApiError(400, "CHUNK_DIGEST_MISMATCH");
  }
  const current = await currentTelemetryV1Chunk(
    env.USAGE_MONITOR_DB,
    participant.id,
    deviceId,
    chunk.stream,
    chunk.chunkDay,
    chunk.chunkSeq,
  );
  // Content replay is scoped to the FULL chunk identity: only this exact
  // (device, stream, day, seq) chunk with an equal digest is a replay. An
  // equal digest anywhere else is a coincidence and proceeds as an insert.
  if (current && current.chunk_digest === chunk.chunkDigest) {
    return telemetryV1ChunkReceipt(env, current, deviceId);
  }
  // Same-digest replay answered above, so a declared revision must extend
  // the current one by exactly one; anything else means the client's cursor
  // disagrees with the journal and must re-fetch the manifest.
  if (current
    ? chunk.chunkRevision !== current.revision + 1
    : chunk.chunkRevision !== 1) {
    throw new ApiError(409, "CHUNK_REVISION_CONFLICT");
  }
  const admission = await telemetryV1ChunkAdmission(
    env.USAGE_MONITOR_DB,
    participant.id,
    deviceId,
  );
  if (admission.state === "exhausted") {
    throw telemetryV1ChunkAdmissionError(admission);
  }

  const chunkRowId = `chunk:${crypto.randomUUID()}`;
  const r2Key = `telemetry/v1-${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  await putTrackedQuarantineObject(
    env.USAGE_MONITOR_DB,
    env.QUARANTINE,
    {
      contributionId: chunkRowId,
      objectKind: "telemetry",
      r2Key,
      registeredAt: createdAt,
    },
    JSON.stringify(envelope),
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: {
        contributionId: chunkRowId,
        schemaVersion: TELEMETRY_V1_ENVELOPE_SCHEMA_VERSION,
        plaintextSchemaVersion: chunk.schemaVersion,
        synthetic: "false",
      },
    },
  );
  try {
    const result = await insertTelemetryV1Chunk(env.USAGE_MONITOR_DB, {
      participantId: participant.id,
      deviceId,
      deviceUploadAuthorizationId: uploadAuthorization.authorizationId,
      chunkRowId,
      r2Key,
      envelopeDigest: envelopeDigestValue,
      chunk,
      supersedes: current,
      createdAt,
    });
    const [acknowledgedThroughDay, settledAdmission] = await Promise.all([
      telemetryV1AcknowledgedThroughDay(
        env.USAGE_MONITOR_DB,
        participant.id,
        deviceId,
      ),
      telemetryV1ChunkAdmission(env.USAGE_MONITOR_DB, participant.id, deviceId),
    ]);
    return jsonResponse({
      schemaVersion: "telemetry-chunk-receipt-v1.0",
      contributionId: chunkRowId,
      chunkId: chunk.chunkId,
      chunkRevision: chunk.chunkRevision,
      status: "accepted",
      supersededRevision: current?.revision ?? null,
      recordCounts: {
        declared: chunk.records.length,
        accepted: result.acceptedRecords,
      },
      acknowledgedThroughDay,
      admission: settledAdmission,
    }, 202);
  } catch (error) {
    // The journal batch can have committed before this response was built.
    // A found current row with this exact identity and digest makes this an
    // indeterminate, committed outcome; only a proven-absent row permits
    // removing the orphaned quarantine object.
    const replay = await currentTelemetryV1Chunk(
      env.USAGE_MONITOR_DB,
      participant.id,
      deviceId,
      chunk.stream,
      chunk.chunkDay,
      chunk.chunkSeq,
    );
    if (replay && replay.chunk_digest === chunk.chunkDigest) {
      return telemetryV1ChunkReceipt(env, replay, deviceId);
    }
    try {
      await env.QUARANTINE.delete(r2Key);
      await clearPendingQuarantineObject(env.USAGE_MONITOR_DB, {
        contributionId: chunkRowId,
        r2Key,
      });
    } catch {
      // The reconciliation registration remains durable by design.
    }
    // Trigger aborts and constraint races already carry their typed codes
    // from the repository mapping; only untyped failures fall through to
    // the admission recheck that distinguishes a raced budget exhaustion
    // from a genuine internal error.
    if (error instanceof ApiError) throw error;
    const retryAdmission = await telemetryV1ChunkAdmission(
      env.USAGE_MONITOR_DB,
      participant.id,
      deviceId,
    );
    if (retryAdmission.state === "exhausted") {
      throw telemetryV1ChunkAdmissionError(retryAdmission);
    }
    throw error;
  }
}

const SYNC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/**
 * Shared admission and authentication for the v1.0 cursor read endpoints.
 * The device bearer is the sole authority, exactly as for upload
 * registration; a browser cookie on these endpoints is always a mistake.
 */
async function deviceSyncPrincipal(
  request: Request,
  env: Env,
): Promise<{ participantId: string; deviceId: string }> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  assertAdmissionBindings(env);
  await assertAttemptAllowed(
    env.RECOVERY_RATE_LIMIT,
    env.CLIENT_ATTEMPT_RATE_LIMIT,
    request,
    env,
    "device_sync",
  );
  if (request.headers.has("cookie")) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  const device = await authenticateDevice(
    env.USAGE_MONITOR_DB,
    request.headers.get("authorization"),
  );
  if (await hasDeletionTombstone(env.DELETION_LEDGER, device.participantId)) {
    throw new ApiError(401, "DEVICE_AUTH_INVALID");
  }
  return { participantId: device.participantId, deviceId: device.deviceId };
}

async function handleDeviceSyncState(
  request: Request,
  env: Env,
): Promise<Response> {
  const device = await deviceSyncPrincipal(request, env);
  const [state, admission] = await Promise.all([
    telemetryV1SyncState(
      env.USAGE_MONITOR_DB,
      device.participantId,
      device.deviceId,
    ),
    telemetryV1ChunkAdmission(
      env.USAGE_MONITOR_DB,
      device.participantId,
      device.deviceId,
    ),
  ]);
  return jsonResponse({ ...state, admission });
}

async function handleDeviceSyncManifest(
  request: Request,
  env: Env,
): Promise<Response> {
  const device = await deviceSyncPrincipal(request, env);
  const url = new URL(request.url);
  const fromDay = url.searchParams.get("fromDay");
  const toDay = url.searchParams.get("toDay");
  if (fromDay === null || toDay === null
      || !SYNC_DAY_PATTERN.test(fromDay) || !SYNC_DAY_PATTERN.test(toDay)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const fromEpoch = Date.parse(`${fromDay}T00:00:00.000Z`);
  const toEpoch = Date.parse(`${toDay}T00:00:00.000Z`);
  if (!Number.isFinite(fromEpoch) || !Number.isFinite(toEpoch)
      || fromEpoch > toEpoch) {
    throw new ApiError(400, "BODY_INVALID");
  }
  if ((toEpoch - fromEpoch) / DAY_MILLISECONDS + 1
      > MAX_SYNC_MANIFEST_RANGE_DAYS) {
    throw new ApiError(400, "SYNC_RANGE_TOO_LARGE");
  }
  return jsonResponse(await telemetryV1SyncManifest(
    env.USAGE_MONITOR_DB,
    device.participantId,
    device.deviceId,
    fromDay,
    toDay,
  ));
}

async function handleContribution(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  assertUploadIngressConfiguration(env);
  assertUploadIngressRateLimitBindings(env);
  const bodyReadPolicy = uploadIngressBodyReadPolicy(env);
  const authorizationHeader = contributionRequestPreflight(request);
  await assertUploadIngressRequestAllowed(
    env.UPLOAD_INGRESS_REQUEST_RATE_LIMIT,
    env.UPLOAD_INGRESS_CLIENT_RATE_LIMIT,
    request,
    env,
  );
  // This lease intentionally begins before body consumption. A public request
  // with a syntactically valid bearer header can otherwise force 2 MiB reads,
  // JSON parsing, hashing, or a D1 token lookup without entering the shared
  // budget. Rejections do not consume the one-use authorization, so a client
  // can honor Retry-After and retry the exact prepared envelope.
  const ingressLease = await acquireUploadIngressLease(env);
  const heartbeat = startUploadIngressLeaseHeartbeat(env, ingressLease);
  let completed = false;
  let claimed: {
    authorizationId: string;
    participantId: string;
    authorizationKind: "session" | "device";
  } | null = null;
  try {
    const body = await readBoundedJson(request, bodyReadPolicy);
    await heartbeat.assertActive();
    const contentType = request.headers.get("content-type")?.trim() ?? "";
    const bodyBytes = body.bytes.byteLength;
    const scopeDigest = await sha256Hex(body.bytes);
    await heartbeat.assertActive();
    await assertCollectionControl(env.USAGE_MONITOR_DB, "processing");
    claimed = authorizationHeader.startsWith("Upload um_device_upload_")
      ? await claimDeviceUploadAuthorization(
        env.USAGE_MONITOR_DB,
        authorizationHeader,
        { envelopeDigest: scopeDigest, bodyBytes, contentType },
      )
      : await claimUploadAuthorization(
        env.USAGE_MONITOR_DB,
        authorizationHeader,
        { envelopeDigest: scopeDigest, bodyBytes, contentType },
      );
    await heartbeat.assertActive();
    if (!hasExactEnvelopeKeyOccurrences(body.raw)) {
      throw new ApiError(400, "ENVELOPE_INVALID");
    }
    if (typeof body.value !== "object" || body.value === null || Array.isArray(body.value)) {
      throw new ApiError(400, "ENVELOPE_INVALID");
    }
    const participant = await env.USAGE_MONITOR_DB.prepare(
      `SELECT id, consent_version AS consentVersion
         FROM participants WHERE id = ? AND state = 'active'`,
    ).bind(claimed.participantId).first<{ id: string; consentVersion: string }>();
    if (!participant) throw new ApiError(401, "UPLOAD_AUTH_INVALID");
    if (await hasDeletionTombstone(env.DELETION_LEDGER, participant.id)) {
      throw new ApiError(401, "UPLOAD_AUTH_INVALID");
    }
    await heartbeat.assertActive();
    const declaredEnvelopeVersion = Reflect.get(body.value, "schemaVersion");
    const response = declaredEnvelopeVersion === "telemetry-envelope-v0.1"
      ? await handleTelemetryContribution(request, body, participant, claimed, env)
      : declaredEnvelopeVersion === TELEMETRY_V1_ENVELOPE_SCHEMA_VERSION
        ? await handleTelemetryV1Contribution(body, participant, claimed, env)
        : await handleSyntheticContribution(body, participant, claimed, env);
    await heartbeat.assertActive();
    const receipt = await response.clone().json<{ contributionId?: unknown }>();
    if (typeof receipt.contributionId !== "string") {
      throw new ApiError(500, "INTERNAL_ERROR");
    }
    if (claimed.authorizationKind === "device") {
      await recordDeviceUploadReceipt(
        env.USAGE_MONITOR_DB,
        claimed.authorizationId,
        receipt.contributionId,
      );
    } else {
      await recordUploadReceipt(
        env.USAGE_MONITOR_DB,
        claimed.authorizationId,
        receipt.contributionId,
      );
    }
    completed = true;
    return response;
  } finally {
    try {
      if (!completed && claimed !== null) {
        if (claimed.authorizationKind === "device") {
          await abandonDeviceUploadAuthorization(env.USAGE_MONITOR_DB, claimed.authorizationId);
        } else {
          await abandonUploadAuthorization(env.USAGE_MONITOR_DB, claimed.authorizationId);
        }
      }
    } catch {
      // Preserve the original client-visible status and leave a redacted
      // operational signal if the best-effort token revocation itself fails.
      console.error(JSON.stringify({
        level: "error",
        event: "upload_authorization_abandon_failed",
      }));
    } finally {
      await heartbeat.stop();
      try {
        await releaseUploadIngressLease(env, ingressLease);
      } catch {
        // The renewals leave a finite availability backstop. Do not turn an
        // already committed contribution into a client failure.
        console.warn(JSON.stringify({
          level: "warn",
          event: "upload_ingress_lease_release_failed",
        }));
      }
    }
  }
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  const session = await personalSession(request, env);
  const [
    contributions,
    telemetryContributions,
    telemetryTotal,
    contributionAdmission,
  ] = await Promise.all([
    listContributions(env.USAGE_MONITOR_DB, session.participantId),
    listRecentTelemetryContributions(
      env.USAGE_MONITOR_DB,
      session.participantId,
      MAX_PARTICIPANT_PROFILE_HISTORY_ITEMS
        - MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT,
    ),
    telemetryContributionCount(env.USAGE_MONITOR_DB, session.participantId),
    telemetryContributionAdmission(
      env.USAGE_MONITOR_DB,
      session.participantId,
    ),
  ]);
  const history = ([
    ...contributions.map(contributionHistoryMetadata),
    ...telemetryContributions.map(telemetryContributionHistoryMetadata),
  ] as Array<{ contributionId: string; createdAt: string }>).sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.contributionId.localeCompare(right.contributionId),
  );
  return jsonResponse({
    schemaVersion: "participant-profile-v0.2",
    participantId: session.participantId,
    createdAt: session.participantCreatedAt,
    consentVersion: session.consentVersion,
    syntheticOnly: session.consentVersion === "synthetic-preview-v0.1",
    contributionCount: history.length,
    totalContributionCount: contributions.length + telemetryTotal,
    latestContribution: history[history.length - 1] ?? null,
    contributions: history,
    contributionAdmission,
    historyPolicy: {
      maximumItems: MAX_PARTICIPANT_PROFILE_HISTORY_ITEMS,
      returnedItems: history.length,
      totalItems: contributions.length + telemetryTotal,
      truncated: contributions.length + telemetryTotal > history.length,
      order: "oldest_to_newest_within_recent_window",
      quarantineRetentionMilliseconds: QUARANTINE_RETENTION_MILLISECONDS,
      canonicalMetadataRetainedAfterQuarantine: true,
      clientSoftwareVersion: "unavailable_in_transport",
    },
  }, 200, { vary: "Cookie" });
}

async function handleExport(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  const session = await personalSession(request, env);
  const contributions = await listContributions(env.USAGE_MONITOR_DB, session.participantId);
  const generatedAt = new Date().toISOString();
  const encoder = new TextEncoder();
  const chunks = (async function* participantExportChunks() {
    let wroteContribution = false;
    const serializeContribution = (value: unknown): Uint8Array => {
      const chunk = encoder.encode(
        `${wroteContribution ? "," : ""}${JSON.stringify(value)}`,
      );
      wroteContribution = true;
      return chunk;
    };
    yield encoder.encode(
      `{"schemaVersion":"participant-export-v0.2",`
      + `"syntheticOnly":${JSON.stringify(
        session.consentVersion === "synthetic-preview-v0.1",
      )},`
      + `"participant":${JSON.stringify({
        participantId: session.participantId,
        createdAt: session.participantCreatedAt,
      })},"contributions":[`,
    );
    for (const contribution of contributions) {
      yield serializeContribution(contributionForResponse(contribution));
    }
    let cursor: { createdAt: string; contributionId: string } | null = null;
    do {
      const page = await telemetryContributionPage(
        env.USAGE_MONITOR_DB,
        session.participantId,
        cursor,
      );
      for (const item of page.rows) {
        yield serializeContribution({
          ...telemetryContributionMetadata(item.contribution),
          records: item.records.flatMap((record) => {
            const value = parseStoredRecordJson(record.record_json);
            return value ? [{ kind: record.record_kind, value }] : [];
          }),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    yield encoder.encode(
      `],"generatedAt":${JSON.stringify(generatedAt)}}`,
    );
  })();
  let finished = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        const next = await chunks.next();
        if (next.done) {
          finished = true;
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        finished = true;
        controller.error(error);
      }
    },
    async cancel() {
      if (finished) return;
      finished = true;
      await chunks.return(undefined);
    },
  }, { highWaterMark: 0 });
  const headers = new Headers(JSON_HEADERS);
  headers.set("vary", "Cookie");
  return new Response(stream, { status: 200, headers });
}

async function handleDelete(request: Request, env: Env): Promise<Response> {
  if (request.method !== "DELETE") methodNotAllowed(["DELETE"]);
  const session = await personalSession(request, env, true, true);
  assertCsrf(request, session);
  if (identityRequired(env)) {
    await assertPinnedIdentityLinkSecretConfiguration(
      env.USAGE_MONITOR_DB,
      Reflect.get(env, "IDENTITY_LINK_SECRET"),
      Reflect.get(env, "IDENTITY_LINK_SECRET_VERSION"),
    );
  }
  if (session.participantState === "active") {
    await markParticipantDeleting(
      env.USAGE_MONITOR_DB,
      session.participantId,
      session.sessionId,
    );
  }
  await assertDeletionOwner(
    env.USAGE_MONITOR_DB,
    session.participantId,
    session.sessionId,
  );
  await recordDeletionTombstone(
    env.DELETION_LEDGER,
    session.participantId,
  );
  const identityLinkKey = await participantIdentityLinkKeyForDeletion(
    env.USAGE_MONITOR_DB,
    session.participantId,
    session.sessionId,
  );
  if (identityLinkKey !== null) {
    const rawIdentityLinkSecret = Reflect.get(env, "IDENTITY_LINK_SECRET");
    if (typeof rawIdentityLinkSecret !== "string"
        || rawIdentityLinkSecret.length < 32) {
      if (identityRequired(env)) {
        throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
      }
    } else {
      const cooldownDigest = await identityReenrollmentCooldownDigest(
        rawIdentityLinkSecret,
        identityLinkKey,
      );
      // Persist the primary marker before dropping the old unique link key.
      // The external ledger remains the independent restoration safeguard;
      // this primary marker is what makes fresh INSERT admission atomic.
      await recordPrimaryIdentityReenrollmentCooldown(
        env.USAGE_MONITOR_DB,
        cooldownDigest,
      );
      await recordIdentityReenrollmentCooldownFromDigest(
        env.DELETION_LEDGER,
        cooldownDigest,
      );
    }
  }
  const contributions = await listContributions(env.USAGE_MONITOR_DB, session.participantId);
  if (contributions.length > MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  const telemetryTotal = await telemetryContributionCount(
    env.USAGE_MONITOR_DB,
    session.participantId,
  );
  const telemetryV1Total = await telemetryV1ChunkCount(
    env.USAGE_MONITOR_DB,
    session.participantId,
  );
  const syntheticR2Keys = contributions.map((row) => row.r2_key);
  if (syntheticR2Keys.length > 0) {
    await env.QUARANTINE.delete(syntheticR2Keys);
  }
  let cursor: { createdAt: string; contributionId: string } | null = null;
  do {
    const page = await telemetryContributionR2KeyPage(
      env.USAGE_MONITOR_DB,
      session.participantId,
      cursor,
    );
    if (page.rows.length > 0) {
      await env.QUARANTINE.delete(page.rows.map((row) => row.r2Key));
    }
    cursor = page.nextCursor;
  } while (cursor);
  let chunkCursor: { createdAt: string; chunkRowId: string } | null = null;
  do {
    const page = await telemetryV1ChunkR2KeyPage(
      env.USAGE_MONITOR_DB,
      session.participantId,
      chunkCursor,
    );
    if (page.rows.length > 0) {
      await env.QUARANTINE.delete(page.rows.map((row) => row.r2Key));
    }
    chunkCursor = page.nextCursor;
  } while (chunkCursor);
  const currentTelemetryTotal = await telemetryContributionCount(
    env.USAGE_MONITOR_DB,
    session.participantId,
  );
  const currentTelemetryV1Total = await telemetryV1ChunkCount(
    env.USAGE_MONITOR_DB,
    session.participantId,
  );
  if (currentTelemetryTotal !== telemetryTotal
      || currentTelemetryV1Total !== telemetryV1Total) {
    throw new ApiError(409, "UPLOAD_IN_PROGRESS");
  }
  await finishParticipantDeletion(env.USAGE_MONITOR_DB, session.participantId);
  return jsonResponse({
    deleted: true,
    participantId: session.participantId,
    contributionsDeleted: contributions.length + telemetryTotal
      + telemetryV1Total,
  }, 200, { "set-cookie": clearedSessionCookie(), vary: "Cookie" });
}

async function handleStats(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  const session = await personalSession(request, env);
  const [stats, communityComparison] = await Promise.all([
    personalStats(env.USAGE_MONITOR_DB, session.participantId),
    readParticipantCommunityComparison(
      env.USAGE_MONITOR_DB,
      session.participantId,
    ),
  ]);
  return jsonResponse(
    { ...stats, communityComparison },
    200,
    { vary: "Cookie" },
  );
}

const ADMIN_ACTIONS = new Set<AdminAction>([
  "set_collection_controls",
  "run_maintenance",
  "sync_distribution",
]);
const ADMIN_CONTROL_REASONS = new Set<CollectionControlReason>([
  "drill_containment",
  "drill_restore",
  "privacy_incident",
  "security_incident",
  "abuse_or_cost",
  "maintenance",
]);

async function adminSession(
  request: Request,
  env: Env,
): Promise<{
  session: SessionPrincipal;
  identityKey: string;
}> {
  const session = await personalSession(request, env);
  const identityKey = await authorizeAdminIdentity(
    env.USAGE_MONITOR_DB,
    session.participantId,
    Reflect.get(env, "ADMIN_IDENTITY_LINK_KEY"),
  );
  return { session, identityKey };
}

async function handleAdminMetricsHistory(
  request: Request,
  env: Env,
  access?: { readonly identityKey: string },
): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  // Same two auth postures as the overview: access-mode was verified and
  // owner-pinned at the admin-hostname chokepoint; dev-mode keeps the
  // 503-before-auth ordering and the app-session gate. GETs are never
  // origin-gated — same-origin GETs carry no Origin header.
  if (access === undefined) {
    if (!adminIdentityKeyConfigured(Reflect.get(env, "ADMIN_IDENTITY_LINK_KEY"))) {
      throw new ApiError(503, "ADMIN_NOT_CONFIGURED");
    }
    await adminSession(request, env);
  }
  const history = await readAdminMetricsHistory(env.USAGE_MONITOR_DB, Date.now());
  return jsonResponse(history, 200, {
    "cache-control": "no-store",
    vary: "Cookie",
  });
}

async function handleAdminOverview(
  request: Request,
  env: Env,
  access?: { readonly identityKey: string },
): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  // access-mode (admin hostname): the router already verified Cloudflare Access
  // and pinned the owner email, and overview is read-only, so proceed directly.
  // dev-mode (single origin): keep the 503-before-auth ordering and the app
  // session + ADMIN_IDENTITY_LINK_KEY gate.
  if (access === undefined) {
    if (!adminIdentityKeyConfigured(Reflect.get(env, "ADMIN_IDENTITY_LINK_KEY"))) {
      throw new ApiError(503, "ADMIN_NOT_CONFIGURED");
    }
    await adminSession(request, env);
  }
  const reference = new URL(request.url).searchParams.get("diagnosticReference");
  if (reference !== null && !validDiagnosticReference(reference)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const nowEpoch = Date.now();
  const distributionEnabled = env.ENVIRONMENT === "production";
  const [overview, ingress, githubSnapshot] = await Promise.all([
    readAdminOverview(env.USAGE_MONITOR_DB, env.DELETION_LEDGER, {
      environment: env.ENVIRONMENT,
      enrollmentMode: env.ENROLLMENT_MODE,
      accountScopedIngestMode: env.ACCOUNT_SCOPED_INGEST_MODE,
      diagnosticReference: reference ?? undefined,
      nowEpoch,
    }),
    readUploadIngressStatus(env),
    distributionEnabled
      ? readGithubDistributionSnapshot(env.USAGE_MONITOR_DB, nowEpoch)
        .catch(() => githubUnavailable("unavailable", "GITHUB_SNAPSHOT_UNAVAILABLE"))
      : Promise.resolve(undefined),
  ]);
  const distribution = await readDistributionAnalytics({
    enabled: distributionEnabled,
    cloudflareZoneId: Reflect.get(env, "DISTRIBUTION_ANALYTICS_ZONE_ID"),
    cloudflareApiToken: Reflect.get(
      env,
      "DISTRIBUTION_ANALYTICS_API_TOKEN",
    ),
    githubApiToken: Reflect.get(env, "DISTRIBUTION_GITHUB_API_TOKEN"),
    githubSnapshot,
  }, nowEpoch);
  return jsonResponse(
    { ...overview, ingress, distribution },
    200,
    { "cache-control": "no-store", vary: "Cookie" },
  );
}

async function handleAdminAction(
  request: Request,
  env: Env,
  access?: { readonly identityKey: string },
): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  let identityKey: string;
  if (access !== undefined) {
    // access-mode (admin hostname): identity is the owner-pinned Access email;
    // CSRF is session-independent (exact-origin + mandatory custom header).
    assertAdminCsrf(request);
    identityKey = access.identityKey;
  } else {
    const { session, identityKey: devIdentityKey } = await adminSession(request, env);
    assertCsrf(request, session);
    identityKey = devIdentityKey;
  }
  const body = await readBoundedJson(request);
  if (typeof body.value !== "object"
      || body.value === null
      || Array.isArray(body.value)
      || typeof Reflect.get(body.value, "action") !== "string") {
    throw new ApiError(400, "BODY_INVALID");
  }
  const action = Reflect.get(body.value, "action") as string;
  if (!ADMIN_ACTIONS.has(action as AdminAction)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  if (action === "run_maintenance") {
    if (Object.keys(body.value).length !== 1) throw new ApiError(400, "BODY_INVALID");
    const operationId = await beginAdminOperation(
      env.USAGE_MONITOR_DB,
      identityKey,
      "run_maintenance",
      { phase: "started" },
    );
    try {
      const result = await runScheduledMaintenance(env, Date.now());
      if (result.code === "MAINTENANCE_IN_PROGRESS") {
        throw new ApiError(409, "LIFECYCLE_STATE_CONFLICT");
      }
      await finishAdminOperation(
        env.USAGE_MONITOR_DB,
        operationId,
        "success",
        {
          code: result.code,
          lifecycleComplete: result.lifecycleComplete,
          quarantineReconciliationComplete: result.quarantineReconciliationComplete,
          expiredIdentityHandoffsPurged: result.expiredIdentityHandoffsPurged,
          expiredIdentityHandoffPurgeComplete: result.expiredIdentityHandoffPurgeComplete,
          expiredDeletionTombstonesPurged: result.expiredDeletionTombstonesPurged,
          deletionTombstonePurgeComplete: result.deletionTombstonePurgeComplete,
          expiredPrimaryIdentityReenrollmentCooldownsPurged:
            result.expiredPrimaryIdentityReenrollmentCooldownsPurged,
          primaryIdentityReenrollmentCooldownPurgeComplete:
            result.primaryIdentityReenrollmentCooldownPurgeComplete,
          expiredIdentityReenrollmentCooldownsPurged:
            result.expiredIdentityReenrollmentCooldownsPurged,
          identityReenrollmentCooldownPurgeComplete:
            result.identityReenrollmentCooldownPurgeComplete,
          aggregateRebuildComplete: result.aggregateRebuildComplete,
          publicationEnabled: result.publicationEnabled,
        },
      );
      return jsonResponse(
        { schemaVersion: "admin-action-v0.1", action, result },
        200,
        { "cache-control": "no-store", vary: "Cookie" },
      );
    } catch (error) {
      try {
        await finishAdminOperation(
          env.USAGE_MONITOR_DB,
          operationId,
          "failure",
          { code: error instanceof ApiError ? error.code : "INTERNAL_ERROR" },
        );
      } catch {
        // Preserve the original maintenance failure response.
      }
      throw error;
    }
  }

  if (action === "sync_distribution") {
    if (Object.keys(body.value).length !== 1) throw new ApiError(400, "BODY_INVALID");
    const operationId = await beginAdminOperation(
      env.USAGE_MONITOR_DB,
      identityKey,
      "sync_distribution",
      { phase: "started" },
    );
    try {
      const result = await syncGithubDistributionSnapshots(
        env.USAGE_MONITOR_DB,
        {
          enabled: env.ENVIRONMENT === "production",
          githubApiToken: Reflect.get(env, "DISTRIBUTION_GITHUB_API_TOKEN"),
        },
        Date.now(),
        fetch,
        { force: true },
      );
      if (result.code === "GITHUB_SYNC_FAILED") {
        await finishAdminOperation(
          env.USAGE_MONITOR_DB,
          operationId,
          "failure",
          { code: result.failureCode ?? "GITHUB_UNAVAILABLE" },
        );
        throw new ApiError(503, "DISTRIBUTION_SYNC_UNAVAILABLE");
      }
      await finishAdminOperation(
        env.USAGE_MONITOR_DB,
        operationId,
        "success",
        {
          code: result.code,
          observedAt: result.observedAt,
        },
      );
      return jsonResponse(
        { schemaVersion: "admin-action-v0.1", action, result },
        200,
        { "cache-control": "no-store", vary: "Cookie" },
      );
    } catch (error) {
      if (!(error instanceof ApiError
          && error.code === "DISTRIBUTION_SYNC_UNAVAILABLE")) {
        try {
          await finishAdminOperation(
            env.USAGE_MONITOR_DB,
            operationId,
            "failure",
            { code: error instanceof ApiError ? error.code : "INTERNAL_ERROR" },
          );
        } catch {
          // Preserve the original sync failure response.
        }
      }
      throw error;
    }
  }

  const expectedKeys = [
    "action", "enrollment", "uploadRegistration", "processing", "publication",
    "reasonCode", "expectedRevision",
  ].sort();
  if (Object.keys(body.value).sort().join("\0") !== expectedKeys.join("\0")
      || typeof Reflect.get(body.value, "enrollment") !== "boolean"
      || typeof Reflect.get(body.value, "uploadRegistration") !== "boolean"
      || typeof Reflect.get(body.value, "processing") !== "boolean"
      || typeof Reflect.get(body.value, "publication") !== "boolean"
      || typeof Reflect.get(body.value, "reasonCode") !== "string"
      || !Number.isSafeInteger(Reflect.get(body.value, "expectedRevision"))
      || (Reflect.get(body.value, "expectedRevision") as number) < 1
      || !ADMIN_CONTROL_REASONS.has(
        Reflect.get(body.value, "reasonCode") as CollectionControlReason,
      )) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const reasonCode = Reflect.get(body.value, "reasonCode") as CollectionControlReason;
  const expectedRevision = Reflect.get(body.value, "expectedRevision") as number;
  const flags = {
    enrollment: Reflect.get(body.value, "enrollment") as boolean,
    uploadRegistration: Reflect.get(body.value, "uploadRegistration") as boolean,
    processing: Reflect.get(body.value, "processing") as boolean,
    publication: Reflect.get(body.value, "publication") as boolean,
  };
  const controls = await setCollectionControls(
    env.USAGE_MONITOR_DB,
    identityKey,
    flags,
    reasonCode,
    expectedRevision,
  );
  return jsonResponse(
    { schemaVersion: "admin-action-v0.1", action, collection: controls },
    200,
    { "cache-control": "no-store", vary: "Cookie" },
  );
}

async function handleCommunityStats(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  await assertCollectionControl(env.USAGE_MONITOR_DB, "publication");
  await assertPublicAggregateReadAllowed(env.PUBLIC_READ_RATE_LIMIT, request, env);
  const snapshot = await readLatestCommunityWeeklySnapshot(env.USAGE_MONITOR_DB);
  if (!snapshot.cacheable) {
    return new Response(snapshot.payloadJson, {
      headers: { ...JSON_HEADERS, "cache-control": "no-store" },
    });
  }
  const etag = `"community-snapshot-${snapshot.snapshotId}-r${snapshot.revision}"`;
  const headers = new Headers({
    ...JSON_HEADERS,
    // A released payload is sealed to this revision. Keep browsers
    // revalidating the mutable `latest` route, while allowing a shared edge
    // cache to retain this immutable revision briefly.
    "cache-control": "public, max-age=0, must-revalidate, s-maxage=60",
    etag,
  });
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(snapshot.payloadJson, { headers });
}

const COMMUNITY_DAILY_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const COMMUNITY_DAILY_MAX_RANGE_DAYS = 366;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function communityDailyRangeDay(value: string | null): string {
  if (value === null || !COMMUNITY_DAILY_DAY_PATTERN.test(value)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const epoch = Date.parse(`${value}T00:00:00.000Z`);
  // The round-trip comparison rejects calendar-impossible dates such as
  // 2026-02-31 that Date.parse silently normalizes.
  if (!Number.isFinite(epoch)
      || new Date(epoch).toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, "BODY_INVALID");
  }
  return value;
}

async function handleCommunityDaily(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  await assertCollectionControl(env.USAGE_MONITOR_DB, "publication");
  await assertPublicAggregateReadAllowed(env.PUBLIC_READ_RATE_LIMIT, request, env);
  const parameters = new URL(request.url).searchParams;
  for (const name of parameters.keys()) {
    if (name !== "from" && name !== "to") {
      throw new ApiError(400, "BODY_INVALID");
    }
  }
  const from = communityDailyRangeDay(parameters.get("from"));
  const to = communityDailyRangeDay(parameters.get("to"));
  const rangeDays = 1 + Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`))
      / MILLISECONDS_PER_DAY,
  );
  if (rangeDays < 1 || rangeDays > COMMUNITY_DAILY_MAX_RANGE_DAYS) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const rows = await readPublishedCommunityDailyAggregates(
    env.USAGE_MONITOR_DB,
    from,
    to,
  );
  const days = rows.map((row) => {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      // Published rows are hash-stamped and immutable; an unparseable payload
      // is storage corruption, not a client problem.
      throw new ApiError(500, "INTERNAL_ERROR");
    }
    return {
      day: row.day,
      revision: row.revision,
      releasedAt: row.released_at,
      payload,
    };
  });
  return jsonResponse(
    {
      schemaVersion: "community-daily-read-v1.0",
      from,
      to,
      days,
    },
    200,
    // Every returned revision is immutable, but the latest-revision selection
    // is not: withdrawal and late-data recomputation both move it. A modest
    // shared lifetime keeps the read cheap without pinning a stale revision.
    { "cache-control": "public, max-age=300" },
  );
}

const CONTRIBUTION_ID_PATTERN =
  /^contribution:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function handleContributionResource(
  request: Request,
  env: Env,
  operation: "read" | "delete",
): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  const session = await personalSession(request, env);
  assertCsrf(request, session);
  const body = await readBoundedJson(request);
  if (typeof body.value !== "object"
      || body.value === null
      || Array.isArray(body.value)
      || Object.keys(body.value).length !== 1
      || typeof Reflect.get(body.value, "contributionId") !== "string"
      || !CONTRIBUTION_ID_PATTERN.test(
        Reflect.get(body.value, "contributionId") as string,
      )) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const contributionId = Reflect.get(body.value, "contributionId") as string;
  const row = await telemetryContributionById(
    env.USAGE_MONITOR_DB,
    session.participantId,
    contributionId,
  );
  if (!row) throw new ApiError(404, "NOT_FOUND");
  if (operation === "read") {
    const records = await telemetryRecordsForContribution(
      env.USAGE_MONITOR_DB,
      session.participantId,
      contributionId,
    );
    return jsonResponse({
      ...telemetryContributionMetadata(row),
      records: records.flatMap((record) => {
        const value = parseStoredRecordJson(record.record_json);
        return value ? [{ kind: record.record_kind, value }] : [];
      }),
    }, 200, { vary: "Cookie" });
  }
  if (!await markTelemetryContributionDeleting(
    env.USAGE_MONITOR_DB,
    session.participantId,
    contributionId,
  )) {
    throw new ApiError(409, "CONTRIBUTION_DELETE_CONFLICT");
  }
  await env.QUARANTINE.delete(row.r2_key);
  await deleteTelemetryContribution(
    env.USAGE_MONITOR_DB,
    session.participantId,
    contributionId,
  );
  return jsonResponse({ deleted: true, contributionId }, 200, { vary: "Cookie" });
}

type LifecycleReadinessState =
  | "ready"
  | "never_run"
  | "running"
  | "failed"
  | "stale"
  | "incomplete";

interface RetentionReadinessRow {
  state: "never_run" | "running" | "completed" | "failed";
  last_completed_at: string | null;
  maintenance_run_at: string | null;
  quarantine_retention_complete: number;
  restore_replay_complete: number;
}

async function aggregateRebuildComplete(db: D1Database): Promise<boolean> {
  const row = await db.prepare(
    `SELECT (
      EXISTS (SELECT 1 FROM community_weekly_snapshot_rebuilds)
      OR EXISTS (SELECT 1 FROM community_daily_aggregate_rebuilds)
    ) AS pending`,
  ).first<{ pending: number }>();
  if (row?.pending !== 0 && row?.pending !== 1) {
    throw new ApiError(503, "LIFECYCLE_STATE_CONFLICT");
  }
  return row.pending === 0;
}

function lifecycleReadiness(
  retention: RetentionReadinessRow,
  nowEpoch: number,
): {
  fresh: boolean;
  state: LifecycleReadinessState;
} {
  if (retention.state !== "completed") {
    return { fresh: false, state: retention.state };
  }
  const completedEpoch = retention.last_completed_at === null
    ? Number.NaN
    : Date.parse(retention.last_completed_at);
  const fresh = Number.isFinite(completedEpoch)
    && completedEpoch <= nowEpoch
    && nowEpoch - completedEpoch <= BACKEND_LIFECYCLE_STALE_MILLISECONDS;
  if (!fresh) return { fresh: false, state: "stale" };
  if (retention.quarantine_retention_complete !== 1
      || retention.restore_replay_complete !== 1) {
    return { fresh: true, state: "incomplete" };
  }
  return { fresh: true, state: "ready" };
}

async function handleReady(
  request: Request,
  env: Env,
  nowEpoch = Date.now(),
): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  assertAdmissionBindings(env);
  assertUploadAuthorizationBindings(env);
  assertUploadIngressRateLimitBindings(env);
  assertUploadIngressConfiguration(env);
  assertSignInStartAdmissionConfiguration(env);
  await probeUploadIngressBudget(env);
  const retention = await env.USAGE_MONITOR_DB.prepare(
    `SELECT state, last_completed_at, maintenance_run_at,
            quarantine_retention_complete, restore_replay_complete
       FROM retention_state
      WHERE singleton = 1`,
  ).first<RetentionReadinessRow>();
  if (!retention) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
  const lifecycle = lifecycleReadiness(retention, nowEpoch);
  const reconciliation = await readQuarantineReconciliationStatus(
    env.USAGE_MONITOR_DB,
  );
  const rebuildComplete = await aggregateRebuildComplete(
    env.USAGE_MONITOR_DB,
  );
  const maintenanceCycleMatched =
    retention.maintenance_run_at !== null
    && reconciliation.maintenanceRunAt === retention.maintenance_run_at;
  const reconciliationComplete = reconciliation.state === "completed"
    && reconciliation.reconciliationComplete
    && maintenanceCycleMatched;
  const ready = lifecycle.state === "ready"
    && rebuildComplete
    && reconciliationComplete;
  return jsonResponse({
    status: ready ? "ready" : "not_ready",
    checks: {
      lifecycle: lifecycle.state,
      lifecycleFresh: lifecycle.fresh,
      quarantineRetentionComplete:
        retention.quarantine_retention_complete === 1,
      restoreReplayComplete: retention.restore_replay_complete === 1,
      aggregateRebuildComplete: rebuildComplete,
      maintenanceCycleMatched,
      quarantineReconciliation: reconciliation.state,
      quarantineReconciliationComplete: reconciliationComplete,
    },
    policy: {
      lifecycleStaleAfterMilliseconds:
        BACKEND_LIFECYCLE_STALE_MILLISECONDS,
    },
  }, ready ? 200 : 503);
}

function unreachableApiRoute(_: never): never {
  throw new ApiError(500, "INTERNAL_ERROR");
}

async function routeApi(
  request: Request,
  env: Env,
  routeId: ApiWorkerRouteId,
): Promise<Response> {
  switch (routeId) {
    // This retired non-API path is dispatched here so it cannot fall through
    // to SPA asset handling.
    case "apple_domain_association":
      return handleRetiredAppleDomainAssociation();
    case "enroll":
      return handleEnroll(request, env);
    case "sparkle_appcast_guard":
      return handleSparkleAppcastGuard(request, env);
    case "identity_google_start":
      return handleIdentityGoogleStart(request, env);
    case "identity_google_callback":
      return handleIdentityGoogleCallback(request, env);
    case "identity_google_result":
      return handleIdentityGoogleResult(request, env);
    case "identity_apple_start":
      return handleIdentityAppleStart(request, env);
    case "identity_apple_callback":
      return handleIdentityAppleCallback(request, env);
    case "identity_apple_result":
      return handleIdentityAppleResult(request, env);
    case "recover":
      return handleRecover(request, env);
    case "session":
      return handleSession(request, env);
    case "logout":
      return handleLogout(request, env);
    case "admin_overview":
      return handleAdminOverview(request, env);
    case "admin_metrics_history":
      return handleAdminMetricsHistory(request, env);
    case "admin_action":
      return handleAdminAction(request, env);
    case "security_reset":
      return handleSecurityReset(request, env);
    case "upload_authorization":
      return handleUploadAuthorization(request, env);
    case "device_pairing":
      return handleDevicePairing(request, env);
    case "device_pairing_claim":
      return handleDevicePairingClaim(request, env);
    case "device_upload_authorization":
      return handleDeviceUploadAuthorization(request, env);
    case "device_disconnect":
      return handleDeviceDisconnect(request, env);
    case "device_credential_renew":
      return handleDeviceCredentialRenew(request, env);
    case "device_sync_state":
      return handleDeviceSyncState(request, env);
    case "device_sync_manifest":
      return handleDeviceSyncManifest(request, env);
    case "participant_devices":
      return handleDevices(request, env);
    case "participant_device_revocation":
      return handleDeviceRevocation(request, env);
    case "envelope_key":
      return handleEnvelopeKey(request, env);
    case "contributions":
      return handleContribution(request, env);
    case "contribution_read":
      return handleContributionResource(request, env, "read");
    case "contribution_delete":
      return handleContributionResource(request, env, "delete");
    case "participant_export":
      return handleExport(request, env);
    case "participant_stats":
      return handleStats(request, env);
    case "community_stats":
      return handleCommunityStats(request, env);
    case "community_daily":
      return handleCommunityDaily(request, env);
    case "participant":
      if (request.method === "DELETE") return handleDelete(request, env);
      return handleMe(request, env);
  }
  return unreachableApiRoute(routeId);
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  const route = matchWorkerRoute(url.pathname);
  try {
    const canonicalRedirectUrl = canonicalPublicRedirectUrl(url, env);
    if (canonicalRedirectUrl !== null) {
      return Response.redirect(canonicalRedirectUrl, 308);
    }
    // Hostname split for the owner-only admin surface. When PUBLIC_ORIGIN is
    // pinned, the admin UI and /api/v1/admin/* exist solely on
    // admin.<public host> behind Cloudflare Access; every request there must
    // carry a verifiable Cf-Access-Jwt-Assertion (defense in depth beneath
    // the edge policy), and the public origin keeps its deliberate 404s.
    // Development environments pin no PUBLIC_ORIGIN and are unchanged.
    const configuredAdminHostname = adminHostname(env);
    if (configuredAdminHostname !== null) {
      if (url.hostname === configuredAdminHostname) {
        // Authenticate + owner-pin ONCE, at the chokepoint, before the UI or
        // any route: Cloudflare Access already verified the Google identity;
        // authorizeAdminEmail confirms it is the configured owner (a valid but
        // non-owner Access identity is 403 here, an unset ACCESS_ADMIN_EMAIL is
        // 503) so the static UI and every present/future admin route are
        // owner-only, and the admin API handlers receive the identity directly
        // rather than re-deriving an impossible __Host- session on this host.
        const identity = await verifyAdminAccessAssertion(request, env);
        const identityKey = authorizeAdminEmail(
          identity,
          Reflect.get(env, "ACCESS_ADMIN_EMAIL"),
        );
        const adminUi = adminUiResponse(request.method, url.pathname);
        if (adminUi !== null) return adminUi;
        if (route.kind === "exact" && route.id === "admin_overview") {
          return noStore(await handleAdminOverview(request, env, { identityKey }));
        }
        if (route.kind === "exact" && route.id === "admin_metrics_history") {
          return noStore(
            await handleAdminMetricsHistory(request, env, { identityKey }),
          );
        }
        if (route.kind === "exact" && route.id === "admin_action") {
          return noStore(await handleAdminAction(request, env, { identityKey }));
        }
      } else if (isAdminSurfacePath(url.pathname)
        || (route.kind === "exact"
          && (route.id === "admin_overview"
            || route.id === "admin_metrics_history"
            || route.id === "admin_action"))) {
        throw new ApiError(404, "NOT_FOUND");
      }
    }
    if (route.id === "ready") {
      return noStore(await handleReady(request, env));
    }
    if (route.id === "health") {
      if (request.method !== "GET") methodNotAllowed(["GET"]);
      const enrollmentMode = configuredEnrollmentMode(env);
      assertAdmissionBindings(env);
      assertUploadAuthorizationBindings(env);
      assertUploadIngressRateLimitBindings(env);
      assertUploadIngressConfiguration(env);
      assertSignInStartAdmissionConfiguration(env);
      await probeUploadIngressBudget(env);
      const collectionControls = await readCollectionControls(
        env.USAGE_MONITOR_DB,
      );
      const retention = await env.USAGE_MONITOR_DB.prepare(
        `SELECT state, quarantine_retention_complete, restore_replay_complete
           FROM retention_state WHERE singleton = 1`,
      ).first<{
        state: "never_run" | "running" | "completed" | "failed";
        quarantine_retention_complete: number;
        restore_replay_complete: number;
      }>();
      if (!retention) throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      if (!env.QUARANTINE
          || typeof Reflect.get(env.QUARANTINE, "head") !== "function"
          || typeof Reflect.get(env.QUARANTINE, "put") !== "function"
          || typeof Reflect.get(env.QUARANTINE, "delete") !== "function") {
        throw new ApiError(503, "BACKEND_STORAGE_UNAVAILABLE");
      }
      await env.USAGE_MONITOR_DB.prepare("SELECT 1").first();
      await env.DELETION_LEDGER.prepare(
        "SELECT schema_version FROM deletion_tombstones LIMIT 1",
      ).first();
      await env.QUARANTINE.head("__usage_monitor_health_probe__");
      const deploymentSourceCommit = configuredDeploymentSourceCommit(env);
      return noStore(jsonResponse({
        status: "ok",
        mode: "synthetic-and-private-telemetry",
        enrollmentMode,
        ...(deploymentSourceCommit === null
          ? {}
          : { deployment: { sourceCommit: deploymentSourceCommit } }),
        collectionControls: {
          state: collectionControls.state,
          enrollment: collectionControls.enrollment
            && enrollmentMode !== "disabled",
          uploadRegistration: collectionControls.uploadRegistration,
          processing: collectionControls.processing,
          publication: collectionControls.publication,
        },
        checks: {
          database: "ok",
          deletionLedger: "ok",
          encryptedObjectStore: "reachable",
          lifecycle: retention.state,
          quarantineRetentionComplete:
            retention.quarantine_retention_complete === 1,
          restoreReplayComplete: retention.restore_replay_complete === 1,
        },
        contracts: {
          acceptedContribution: "telemetry-contribution-v0.1",
          accountScopedContribution: {
            schemaVersion: "telemetry-contribution-v0.2",
            status: configuredAccountScopedIngestMode(env) === "local_preview"
              ? "local_preview_loopback_only"
              : "implementation_disabled",
            externalParticipantsAuthorized: false,
          },
          incrementalContribution: {
            schemaVersion: "telemetry-contribution-v1.0",
            status: "implementation_ready",
            // Owner decision 2026-08-21: external participants ARE authorized
            // on the production deployment — enrollment was already open at
            // the pairing layer, and this declaration now matches that
            // reality instead of contradicting it. Env-driven rather than a
            // literal so staging and synthetic keep declaring false and their
            // containment checks (deploy-disabled-staging) stay meaningful.
            // The v0.2 account-scoped declaration above stays false: that
            // path is implementation_disabled and authorizes no one.
            externalParticipantsAuthorized:
              Reflect.get(env, "INCREMENTAL_EXTERNAL_PARTICIPANTS")
                === "authorized",
          },
        },
        capabilities: {
          encryptedUpload: collectionControls.processing,
          serverValidation: true,
          idempotentDeduplication: true,
          participantStats: true,
          delayedAggregateStats: collectionControls.publication,
          participantExport: true,
          participantDeletion: true,
          boundedQuarantineRetention: true,
          deletionSafeRestoreReplay: true,
          ongoingDeviceUploadRegistration:
            collectionControls.uploadRegistration,
          coordinatedSignInAdmission: true,
        },
      }));
    }
    if (route.id === "unknown_api") throw new ApiError(404, "NOT_FOUND");
    if (route.id !== "asset") {
      const response = await routeApi(request, env, route.id);
      return route.id === "community_stats" || route.id === "community_daily"
        ? response
        : noStore(response);
    }
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    headers.set(
      "content-security-policy",
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  } catch (error) {
    const apiError = error instanceof ApiError
      ? error
      : new ApiError(500, "INTERNAL_ERROR");
    if (apiError.code === "IDENTITY_RESULT_PENDING") {
      // The desktop polls this route while the provider is still open. A 404
      // here is flow control, not a support incident: keep one structured
      // info event in live logs and never persist it as a diagnostic failure.
      console.log(JSON.stringify({
        level: "info",
        event: "request_pending",
        requestId,
        method: request.method,
        routeClass: route.routeClass,
        code: apiError.code,
        status: apiError.status,
      }));
      return noStore(errorResponse(apiError, requestId));
    }
    const expectedContainment = [
      "COLLECTION_ENROLLMENT_DISABLED",
      "UPLOAD_REGISTRATION_DISABLED",
      "PROCESSING_DISABLED",
      "PUBLICATION_DISABLED",
    ].includes(apiError.code);
    const log = {
      level: apiError.status >= 500 && !expectedContainment ? "error" : "warn",
      event: "request_failed",
      requestId,
      method: request.method,
      routeClass: route.routeClass,
      code: apiError.code,
      status: apiError.status,
    };
    if (log.level === "error") console.error(JSON.stringify(log));
    else console.warn(JSON.stringify(log));
    await recordDiagnosticError(
      env.USAGE_MONITOR_DB,
      requestId,
      route.routeClass,
      apiError.code,
      apiError.status,
    );
    const response = errorResponse(apiError, requestId);
    const allow = allowedHeader(apiError);
    if (!allow) return noStore(response);
    const headers = new Headers(response.headers);
    for (const [name, value] of new Headers(allow)) headers.set(name, value);
    return noStore(new Response(response.body, { status: response.status, headers }));
  }
}

interface ScheduledMaintenanceLog {
  level: "info" | "error";
  event: "scheduled_backend_maintenance";
  outcome: "success" | "failure";
  code: string;
  lifecycleComplete: boolean;
  quarantineRetentionComplete: boolean;
  restoreReplayComplete: boolean;
  quarantineReconciliationComplete: boolean;
  expiredIdentityHandoffsPurged: number;
  expiredIdentityHandoffPurgeComplete: boolean;
  expiredDeletionTombstonesPurged: number;
  deletionTombstonePurgeComplete: boolean;
  expiredPrimaryIdentityReenrollmentCooldownsPurged: number;
  primaryIdentityReenrollmentCooldownPurgeComplete: boolean;
  expiredIdentityReenrollmentCooldownsPurged: number;
  identityReenrollmentCooldownPurgeComplete: boolean;
  expiredSignInAdmissionsPurged: number;
  signInAdmissionPurgeComplete: boolean;
  staleDevicePairingsRevoked: number;
  staleDeviceCredentialsRevoked: number;
  staleDeviceUploadAuthorizationsRevoked: number;
  expiredDeviceCredentialRotationsPurged: number;
  expiredDevicePairingEventsPurged: number;
  aggregateRebuildComplete: boolean;
  publicationEnabled: boolean | null;
}

const MAINTENANCE_LEASE_MILLISECONDS = 20 * 60 * 1_000;

async function acquireMaintenanceLease(
  db: D1Database,
  nowEpoch = Date.now(),
): Promise<string | null> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(nowEpoch + MAINTENANCE_LEASE_MILLISECONDS).toISOString();
  const result = await db.prepare(
    `UPDATE retention_state
        SET maintenance_lease_token = ?, maintenance_lease_expires_at = ?
      WHERE singleton = 1
        AND (maintenance_lease_expires_at IS NULL OR maintenance_lease_expires_at <= ?)`,
  ).bind(token, expiresAt, new Date(nowEpoch).toISOString()).run();
  return result.meta.changes === 1 ? token : null;
}

async function releaseMaintenanceLease(db: D1Database, token: string): Promise<void> {
  await db.prepare(
    `UPDATE retention_state
        SET maintenance_lease_token = NULL, maintenance_lease_expires_at = NULL
      WHERE singleton = 1 AND maintenance_lease_token = ?`,
  ).bind(token).run();
}

async function renewMaintenanceLease(db: D1Database, token: string): Promise<void> {
  const nowEpoch = Date.now();
  const now = new Date(nowEpoch).toISOString();
  const expiresAt = new Date(nowEpoch + MAINTENANCE_LEASE_MILLISECONDS).toISOString();
  const result = await db.prepare(
    `UPDATE retention_state
        SET maintenance_lease_expires_at = ?
      WHERE singleton = 1
        AND maintenance_lease_token = ?
        AND maintenance_lease_expires_at > ?`,
  ).bind(expiresAt, token, now).run();
  if (result.meta.changes !== 1) {
    throw new ApiError(503, "LIFECYCLE_STATE_CONFLICT");
  }
}

async function ownsRenewedMaintenanceLease(
  db: D1Database,
  token: string,
): Promise<boolean> {
  try {
    await renewMaintenanceLease(db, token);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === "LIFECYCLE_STATE_CONFLICT") {
      return false;
    }
    throw error;
  }
}

export async function runScheduledMaintenance(
  env: Env,
  scheduledTime: number,
): Promise<ScheduledMaintenanceLog> {
  let lifecycleComplete = false;
  let quarantineRetentionComplete = false;
  let restoreReplayComplete = false;
  let quarantineReconciliationComplete = false;
  let expiredIdentityHandoffsPurged = 0;
  let expiredIdentityHandoffPurgeComplete = false;
  let expiredDeletionTombstonesPurged = 0;
  let deletionTombstonePurgeComplete = false;
  let expiredPrimaryIdentityReenrollmentCooldownsPurged = 0;
  let primaryIdentityReenrollmentCooldownPurgeComplete = false;
  let expiredIdentityReenrollmentCooldownsPurged = 0;
  let identityReenrollmentCooldownPurgeComplete = false;
  let expiredSignInAdmissionsPurged = 0;
  let signInAdmissionPurgeComplete = false;
  let staleDevicePairingsRevoked = 0;
  let staleDeviceCredentialsRevoked = 0;
  let staleDeviceUploadAuthorizationsRevoked = 0;
  let expiredDeviceCredentialRotationsPurged = 0;
  let expiredDevicePairingEventsPurged = 0;
  let rebuildComplete = false;
  let publicationEnabled: boolean | null = null;
  let maintenanceLease: string | null = null;
  try {
    maintenanceLease = await acquireMaintenanceLease(env.USAGE_MONITOR_DB);
    if (maintenanceLease === null) {
      const log: ScheduledMaintenanceLog = {
        level: "info",
        event: "scheduled_backend_maintenance",
        outcome: "success",
        code: "MAINTENANCE_IN_PROGRESS",
        lifecycleComplete,
        quarantineRetentionComplete,
        restoreReplayComplete,
        quarantineReconciliationComplete,
        expiredIdentityHandoffsPurged,
        expiredIdentityHandoffPurgeComplete,
        expiredDeletionTombstonesPurged,
        deletionTombstonePurgeComplete,
        expiredPrimaryIdentityReenrollmentCooldownsPurged,
        primaryIdentityReenrollmentCooldownPurgeComplete,
        expiredIdentityReenrollmentCooldownsPurged,
        identityReenrollmentCooldownPurgeComplete,
        expiredSignInAdmissionsPurged,
        signInAdmissionPurgeComplete,
        staleDevicePairingsRevoked,
        staleDeviceCredentialsRevoked,
        staleDeviceUploadAuthorizationsRevoked,
        expiredDeviceCredentialRotationsPurged,
        expiredDevicePairingEventsPurged,
        aggregateRebuildComplete: rebuildComplete,
        publicationEnabled,
      };
      console.log(JSON.stringify(log));
      return log;
    }
    // Keep a non-null token for callback capture. The outer variable remains
    // available to the unconditional, best-effort final release below.
    const ownedMaintenanceLease = maintenanceLease;
    await renewMaintenanceLease(env.USAGE_MONITOR_DB, maintenanceLease);
    await pruneDiagnosticErrors(env.USAGE_MONITOR_DB);
    // Distribution snapshots are independent owner diagnostics. A transient
    // GitHub failure must be recorded for the admin view but must never block
    // deletion retention, object reconciliation, or community publication.
    try {
      const distributionSync = await syncGithubDistributionSnapshots(
        env.USAGE_MONITOR_DB,
        {
          enabled: env.ENVIRONMENT === "production",
          githubApiToken: Reflect.get(env, "DISTRIBUTION_GITHUB_API_TOKEN"),
        },
        Date.now(),
      );
      if (distributionSync.code === "GITHUB_SYNC_FAILED") {
        console.warn(JSON.stringify({
          level: "warn",
          event: "github_distribution_sync",
          outcome: "failure",
          code: distributionSync.failureCode,
        }));
      }
    } catch {
      // The regular maintenance work below remains authoritative. The next
      // overview will surface a snapshot-storage failure as source-unavailable.
    }
    // Hourly gauge snapshots for the owner metrics history. Same isolation
    // contract as the distribution sync: an unavailable snapshot store (or an
    // unapplied migration 0038) must never block retention, reconciliation,
    // or publication. The capture self-throttles to hourly and never throws.
    try {
      const snapshot = await captureAdminMetricSnapshot(
        env.USAGE_MONITOR_DB,
        Date.now(),
      );
      if (snapshot.code === "SNAPSHOT_UNAVAILABLE") {
        console.warn(JSON.stringify({
          level: "warn",
          event: "admin_metric_snapshot",
          outcome: "failure",
          code: snapshot.code,
        }));
      }
    } catch {
      // captureAdminMetricSnapshot reports rather than throws; this guard
      // exists so no future edit can turn a metrics failure into a
      // maintenance failure.
    }
    const handoffPurge = await purgeExpiredIdentityHandoffs(
      env.USAGE_MONITOR_DB,
      // A delayed Cron invocation must still clear handoffs that have expired
      // by the time the Worker actually runs; snapshot construction continues
      // to use the scheduled timestamp for deterministic reporting periods.
      new Date().toISOString(),
    );
    expiredIdentityHandoffsPurged = handoffPurge.purged;
    expiredIdentityHandoffPurgeComplete = handoffPurge.complete;
    const deletionTombstonePurge = await purgeExpiredDeletionTombstones(
      env.DELETION_LEDGER,
    );
    expiredDeletionTombstonesPurged = deletionTombstonePurge.purged;
    deletionTombstonePurgeComplete = deletionTombstonePurge.complete;
    const primaryIdentityReenrollmentCooldownPurge =
      await purgeExpiredPrimaryIdentityReenrollmentCooldowns(
        env.USAGE_MONITOR_DB,
      );
    expiredPrimaryIdentityReenrollmentCooldownsPurged =
      primaryIdentityReenrollmentCooldownPurge.purged;
    primaryIdentityReenrollmentCooldownPurgeComplete =
      primaryIdentityReenrollmentCooldownPurge.complete;
    const identityReenrollmentCooldownPurge =
      await purgeExpiredIdentityReenrollmentCooldowns(
        env.DELETION_LEDGER,
      );
    expiredIdentityReenrollmentCooldownsPurged =
      identityReenrollmentCooldownPurge.purged;
    identityReenrollmentCooldownPurgeComplete =
      identityReenrollmentCooldownPurge.complete;
    const signInAdmissionPurge = await purgeExpiredSignInStartAdmissions(
      env.USAGE_MONITOR_DB,
    );
    expiredSignInAdmissionsPurged = signInAdmissionPurge.purged;
    signInAdmissionPurgeComplete = signInAdmissionPurge.complete;
    const deviceLifecycle = await purgeStaleDeviceLifecycleRows(
      env.USAGE_MONITOR_DB,
    );
    staleDevicePairingsRevoked = deviceLifecycle.pairingsRevoked;
    staleDeviceCredentialsRevoked = deviceLifecycle.devicesRevoked;
    staleDeviceUploadAuthorizationsRevoked = deviceLifecycle.uploadsRevoked;
    expiredDeviceCredentialRotationsPurged = deviceLifecycle.rotationsPurged;
    expiredDevicePairingEventsPurged = deviceLifecycle.pairingEventsPurged;
    await renewMaintenanceLease(env.USAGE_MONITOR_DB, maintenanceLease);
    const lifecycle = await runBackendLifecycle(
      env.USAGE_MONITOR_DB,
      env.DELETION_LEDGER,
      env.QUARANTINE,
      scheduledTime,
      () => ownsRenewedMaintenanceLease(
        env.USAGE_MONITOR_DB,
        ownedMaintenanceLease,
      ),
      Reflect.get(env, "IDENTITY_LINK_SECRET"),
      !identityRequired(env),
    );
    quarantineRetentionComplete =
      lifecycle.quarantineRetentionComplete;
    restoreReplayComplete = lifecycle.restoreReplayComplete;
    lifecycleComplete = quarantineRetentionComplete
      && restoreReplayComplete;

    await renewMaintenanceLease(env.USAGE_MONITOR_DB, maintenanceLease);
    const reconciliation = await reconcilePendingQuarantineObjects(
      env.USAGE_MONITOR_DB,
      env.QUARANTINE,
      scheduledTime,
    );
    quarantineReconciliationComplete =
      reconciliation.reconciliationComplete;

    const controls = await readCollectionControls(env.USAGE_MONITOR_DB);
    publicationEnabled = controls.publication;
    // Community aggregates are computed from already-promoted telemetry rows.
    // Quarantine reconciliation (above) is orthogonal R2 orphan housekeeping and
    // drains a bounded batch per pass, so a bulk-upload backlog (e.g. a large
    // backfill) can leave it incomplete for many passes. Publication must not be
    // held hostage to that housekeeping: the daily aggregates are mutable and
    // drift-reconciled, so republishing a day later as more data settles is the
    // designed behavior. Gate only on lifecycle retention + the publication
    // control; `quarantineReconciliationComplete` still flows into the overall
    // `complete`/`code` below so maintenance honestly reports housekeeping lag.
    if (lifecycleComplete
        && publicationEnabled === true) {
      await renewMaintenanceLease(env.USAGE_MONITOR_DB, maintenanceLease);
      await buildCommunityWeeklySnapshot(
        env.USAGE_MONITOR_DB,
        scheduledTime,
      );
      await renewMaintenanceLease(env.USAGE_MONITOR_DB, maintenanceLease);
      const rebuild = await rebuildPendingCommunityWeeklySnapshots(
        env.USAGE_MONITOR_DB,
        scheduledTime,
      );
      await renewMaintenanceLease(env.USAGE_MONITOR_DB, maintenanceLease);
      const dailyRebuild = await rebuildPendingCommunityDailyAggregates(
        env.USAGE_MONITOR_DB,
        scheduledTime,
      );
      rebuildComplete = !rebuild.remaining && !dailyRebuild.remaining;
    } else {
      rebuildComplete = await aggregateRebuildComplete(
        env.USAGE_MONITOR_DB,
      );
    }

    const complete = lifecycleComplete
      && quarantineReconciliationComplete
      && expiredIdentityHandoffPurgeComplete
      && deletionTombstonePurgeComplete
      && primaryIdentityReenrollmentCooldownPurgeComplete
      && identityReenrollmentCooldownPurgeComplete
      && signInAdmissionPurgeComplete
      && rebuildComplete;
    const log: ScheduledMaintenanceLog = {
      level: "info",
      event: "scheduled_backend_maintenance",
      outcome: "success",
      code: complete ? "OK" : "MAINTENANCE_INCOMPLETE",
      lifecycleComplete,
      quarantineRetentionComplete,
      restoreReplayComplete,
      quarantineReconciliationComplete,
      expiredIdentityHandoffsPurged,
      expiredIdentityHandoffPurgeComplete,
      expiredDeletionTombstonesPurged,
      deletionTombstonePurgeComplete,
      expiredPrimaryIdentityReenrollmentCooldownsPurged,
      primaryIdentityReenrollmentCooldownPurgeComplete,
      expiredIdentityReenrollmentCooldownsPurged,
      identityReenrollmentCooldownPurgeComplete,
      expiredSignInAdmissionsPurged,
      signInAdmissionPurgeComplete,
      staleDevicePairingsRevoked,
      staleDeviceCredentialsRevoked,
      staleDeviceUploadAuthorizationsRevoked,
      expiredDeviceCredentialRotationsPurged,
      expiredDevicePairingEventsPurged,
      aggregateRebuildComplete: rebuildComplete,
      publicationEnabled,
    };
    console.log(JSON.stringify(log));
    return log;
  } catch (error) {
    const log: ScheduledMaintenanceLog = {
      level: "error",
      event: "scheduled_backend_maintenance",
      outcome: "failure",
      code: error instanceof ApiError ? error.code : "INTERNAL_ERROR",
      lifecycleComplete,
      quarantineRetentionComplete,
      restoreReplayComplete,
      quarantineReconciliationComplete,
      expiredIdentityHandoffsPurged,
      expiredIdentityHandoffPurgeComplete,
      expiredDeletionTombstonesPurged,
      deletionTombstonePurgeComplete,
      expiredPrimaryIdentityReenrollmentCooldownsPurged,
      primaryIdentityReenrollmentCooldownPurgeComplete,
      expiredIdentityReenrollmentCooldownsPurged,
      identityReenrollmentCooldownPurgeComplete,
      expiredSignInAdmissionsPurged,
      signInAdmissionPurgeComplete,
      staleDevicePairingsRevoked,
      staleDeviceCredentialsRevoked,
      staleDeviceUploadAuthorizationsRevoked,
      expiredDeviceCredentialRotationsPurged,
      expiredDevicePairingEventsPurged,
      aggregateRebuildComplete: rebuildComplete,
      publicationEnabled,
    };
    console.error(JSON.stringify(log));
    throw error;
  } finally {
    if (maintenanceLease !== null) {
      try {
        // A successor may have acquired an expired lease while this pass was
        // unwinding. Conditional release must never clear its lease or replace
        // the completed/failing outcome of this pass.
        await releaseMaintenanceLease(env.USAGE_MONITOR_DB, maintenanceLease);
      } catch {
        // The lease expires as an availability backstop. Do not turn an
        // otherwise reported lifecycle outcome into a release-only failure.
      }
    }
  }
}

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },
  scheduled(event, env, context): void {
    context.waitUntil(runScheduledMaintenance(env, event.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
