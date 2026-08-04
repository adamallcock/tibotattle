import {
  assertAdmissionBindings,
  assertAttemptAllowed,
  assertPublicAggregateReadAllowed,
  configuredEnrollmentMode,
  parseInviteGrant,
} from "./admission";
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
  listParticipantDevices,
  recordDeviceUploadReceipt,
  revokeParticipantDevice,
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
} from "./identity-apple";
import {
  GOOGLE_SIGNIN_STATE_PATTERN,
  exchangeGoogleAuthorizationCode,
  googleAuthorizeUrl,
  googleCodeChallenge,
  googleSignInConfiguration,
} from "./identity-google";
import { identityRequired, verifyHostedIdentity } from "./identity-oidc";
import {
  clearPendingQuarantineObject,
  putTrackedQuarantineObject,
  readQuarantineReconciliationStatus,
  reconcilePendingQuarantineObjects,
} from "./quarantine-reconciliation";
import {
  hasDeletionTombstone,
  recordDeletionTombstone,
  runBackendLifecycle,
} from "./retention";
import {
  matchWorkerRoute,
  type ApiWorkerRouteId,
} from "./route-registry";
import {
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

async function readBoundedJson(request: Request): Promise<{
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
  if (!request.body) throw new ApiError(400, "BODY_INVALID");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "BODY_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(combined);
    return { bytes: combined, raw, value: JSON.parse(raw) as unknown };
  } catch {
    throw new ApiError(400, "BODY_INVALID");
  }
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
  if (!request.body) throw new ApiError(400, "BODY_INVALID");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ApiError(413, "BODY_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
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
  if (mode === "disabled") throw new ApiError(503, "ENROLLMENT_DISABLED");
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
  const verifiedIdentity = identityProvided
    ? await consumeHostedIdentityProof(env.USAGE_MONITOR_DB, identityValue)
    : null;
  if (deviceBootstrapRequested) {
    await assertCollectionControl(
      env.USAGE_MONITOR_DB,
      "uploadRegistration",
    );
  }
  const consentVersion = Reflect.get(body.value, "consentVersion") as string;
  const reattached = verifiedIdentity
    ? await reattachParticipantByLinkKey(
      env.USAGE_MONITOR_DB,
      verifiedIdentity.linkKeyHex,
      consentVersion,
      { deviceBootstrap: deviceBootstrapRequested },
    )
    : null;
  const inviteGrant = reattached === null && mode === "invite_only"
    ? await parseInviteGrant(Reflect.get(body.value, "inviteCode"))
    : null;
  const enrollment = reattached ?? await enroll(
    env.USAGE_MONITOR_DB,
    consentVersion,
    inviteGrant,
    {
      deviceBootstrap: deviceBootstrapRequested,
      openCommunityEligibility: mode === "open"
        && Reflect.get(body.value, "syntheticOnly") === false,
      identityLinkKey: verifiedIdentity?.linkKeyHex ?? null,
    },
  );
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

const SIGNIN_HANDOFF_TTL_MILLISECONDS = 5 * 60 * 1000;
const MAX_APPLE_CALLBACK_BYTES = 16 * 1024;
// Google returns its authorization code in the redirect's query string. The
// code itself is bounded by the exchange, and this bounds the whole callback
// URL so an oversized redirect is refused before anything is looked up.
const MAX_GOOGLE_CALLBACK_URL_LENGTH = 8 * 1024;
const SIGNIN_HANDOFF_PROOF_PATTERN = /^[A-Za-z0-9_-]{64}$/u;
const SIGNIN_COMPLETED_MESSAGE = "Signed in — return to TiboTattle.";
const SIGNIN_NOT_COMPLETED_MESSAGE =
  "Sign-in was not completed. Return to TiboTattle and start the sign-in again.";
// This is the fixed, registered macOS application URL from the signed bundle.
// It is deliberately not derived from a callback request, state, code, or
// provider payload, so returning to the app reveals nothing from the OAuth
// exchange.
const SIGNIN_CALLBACK_APP_OPEN_URL = "usagemonitor://open";

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
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  const provider = Reflect.get(value, "provider");
  const proof = Reflect.get(value, "proof");
  if (Object.keys(value).sort().join("\0") !== ["proof", "provider"].join("\0")
      || (provider !== "apple" && provider !== "google")
      || typeof proof !== "string"
      || !SIGNIN_HANDOFF_PROOF_PATTERN.test(proof)) {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  return { provider, proof };
}

async function consumeHostedIdentityProof(
  db: D1Database,
  identity: unknown,
): Promise<{ provider: "apple" | "google"; linkKeyHex: string }> {
  const { provider, proof } = hostedIdentityProof(identity);
  const table = provider === "apple"
    ? "apple_signin_handoffs"
    : "google_signin_handoffs";
  const nowIso = new Date().toISOString();
  const claimed = await db.prepare(
    `DELETE FROM ${table}
      WHERE proof = ?
        AND identity_link_key IS NOT NULL
        AND delivered_at IS NOT NULL
        AND expires_at > ?
      RETURNING identity_link_key AS linkKeyHex`,
  ).bind(proof, nowIso).first<{ linkKeyHex: string }>();
  if (!claimed || !/^[0-9a-f]{64}$/u.test(claimed.linkKeyHex)) {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  return { provider, linkKeyHex: claimed.linkKeyHex };
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
): Promise<{ provider: "apple" | "google"; linkKeyHex: string }> {
  if (identityRequired(env)) {
    return verifyHostedIdentity(env, { provider, idToken });
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
  const result = await db.prepare(
    `DELETE FROM apple_signin_handoffs
      WHERE state IN (
        SELECT state FROM apple_signin_handoffs
         WHERE expires_at <= ?
         ORDER BY expires_at, state
         LIMIT ?
      )`,
  ).bind(nowIso, maximumRows).run();
  return result.meta.changes;
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
  await db.prepare(
    `DELETE FROM apple_signin_handoffs
      WHERE state = ?
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?`,
  ).bind(state, nowIso).run();
}

async function discardPendingGoogleHandoff(
  db: D1Database,
  state: string,
  nowIso: string,
): Promise<void> {
  await db.prepare(
    `DELETE FROM google_signin_handoffs
      WHERE state = ?
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?`,
  ).bind(state, nowIso).run();
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
  if (typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || Object.keys(value).length !== 0) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  await deleteExpiredAppleHandoffs(env.USAGE_MONITOR_DB, nowIso);
  // 48 random bytes render as 64 base64url characters.
  const state = randomSecret(48);
  await env.USAGE_MONITOR_DB.prepare(
    `INSERT INTO apple_signin_handoffs
       (state, identity_link_key, proof, created_at, expires_at, delivered_at)
       VALUES (?, NULL, NULL, ?, ?, NULL)`,
  ).bind(
    state,
    nowIso,
    new Date(nowMs + SIGNIN_HANDOFF_TTL_MILLISECONDS).toISOString(),
  ).run();
  return jsonResponse({
    schemaVersion: "identity-apple-start-v0.1",
    state,
    authorizeUrl: appleAuthorizeUrl(configuration, redirectUri, state),
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
  const pending = await env.USAGE_MONITOR_DB.prepare(
    `SELECT state FROM apple_signin_handoffs
      WHERE state = ?
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?`,
  ).bind(state, nowIso).first<{ state: string }>();
  if (!pending) return failure;
  let verified: { provider: "apple" | "google"; linkKeyHex: string };
  try {
    const idToken = await exchangeAppleAuthorizationCode(env, code, redirectUri);
    verified = await verifiedHostedCallbackIdentity(env, "apple", idToken);
  } catch {
    // A provider code can be spent only once. Leaving this handoff pending
    // would make the desktop app poll a state that cannot ever complete.
    await discardPendingAppleHandoff(
      env.USAGE_MONITOR_DB,
      state,
      new Date().toISOString(),
    );
    return failure;
  }
  // Re-checked against the time the exchange finished, not the time it
  // started, so a handoff that expired mid-exchange is never filled.
  const stored = await env.USAGE_MONITOR_DB.prepare(
    `UPDATE apple_signin_handoffs
        SET identity_link_key = ?, proof = ?
      WHERE state = ?
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?`,
  ).bind(verified.linkKeyHex, randomSecret(48), state, new Date().toISOString()).run();
  if (stored.meta.changes !== 1) return failure;
  return signInCallbackPage(SIGNIN_COMPLETED_MESSAGE, { completed: true });
}

/**
 * Reads a completed sign-in back exactly once. This releases a short-lived,
 * opaque proof only; provider credentials never leave the callback and never
 * reach D1. Enrollment atomically deletes the proof when it uses it.
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
  if (Object.keys(value).length !== 1
      || typeof state !== "string"
      || !APPLE_SIGNIN_STATE_PATTERN.test(state)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const nowIso = new Date().toISOString();
  await deleteExpiredAppleHandoffs(env.USAGE_MONITOR_DB, nowIso);
  const delivered = await env.USAGE_MONITOR_DB.prepare(
    `UPDATE apple_signin_handoffs
        SET delivered_at = ?
      WHERE state = ?
        AND identity_link_key IS NOT NULL
        AND proof IS NOT NULL
        AND delivered_at IS NULL
        AND expires_at > ?
      RETURNING proof`,
  ).bind(nowIso, state, nowIso).first<{ proof: string }>();
  if (delivered) {
    return jsonResponse({
      schemaVersion: "identity-apple-result-v0.1",
      proof: delivered.proof,
    });
  }
  const pending = await env.USAGE_MONITOR_DB.prepare(
    `SELECT state FROM apple_signin_handoffs
      WHERE state = ?
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?`,
  ).bind(state, nowIso).first<{ state: string }>();
  if (pending) throw new ApiError(404, "IDENTITY_RESULT_PENDING");
  throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
}

/**
 * Starts a hosted Google sign-in, in the same shape as Apple's: the state row
 * is the whole handoff. It is created empty here with its PKCE verifier,
 * filled by Google's redirect, and read back exactly once by the page that
 * started the flow. No participant, session, or provider identifier is
 * involved at this point, and the verifier never leaves this service.
 */
async function handleIdentityGoogleStart(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  assertSameOrigin(request);
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
  if (typeof value !== "object"
      || value === null
      || Array.isArray(value)
      || Object.keys(value).length !== 0) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  await deleteExpiredGoogleHandoffs(env.USAGE_MONITOR_DB, nowIso);
  // 48 random bytes render as 64 base64url characters, which satisfies both
  // the state pattern and RFC 7636's 43-128 character verifier range.
  const state = randomSecret(48);
  const codeVerifier = randomSecret(48);
  await env.USAGE_MONITOR_DB.prepare(
    `INSERT INTO google_signin_handoffs
       (state, code_verifier, identity_link_key, proof, created_at, expires_at, delivered_at)
       VALUES (?, ?, NULL, NULL, ?, ?, NULL)`,
  ).bind(
    state,
    codeVerifier,
    nowIso,
    new Date(nowMs + SIGNIN_HANDOFF_TTL_MILLISECONDS).toISOString(),
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
  const pending = await env.USAGE_MONITOR_DB.prepare(
    `SELECT code_verifier AS codeVerifier FROM google_signin_handoffs
      WHERE state = ?
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?`,
  ).bind(state, nowIso).first<{ codeVerifier: string }>();
  if (!pending) return failure;
  let verified: { provider: "apple" | "google"; linkKeyHex: string };
  try {
    const idToken = await exchangeGoogleAuthorizationCode(
      env,
      code,
      pending.codeVerifier,
      redirectUri,
    );
    verified = await verifiedHostedCallbackIdentity(env, "google", idToken);
  } catch {
    // A provider code can be spent only once. Leaving this handoff pending
    // would make the desktop app poll a state that cannot ever complete.
    await discardPendingGoogleHandoff(
      env.USAGE_MONITOR_DB,
      state,
      new Date().toISOString(),
    );
    return failure;
  }
  // Re-checked against the time the exchange finished, not the time it
  // started, so a handoff that expired mid-exchange is never filled.
  const stored = await env.USAGE_MONITOR_DB.prepare(
    `UPDATE google_signin_handoffs
        SET code_verifier = NULL, identity_link_key = ?, proof = ?
      WHERE state = ?
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?`,
  ).bind(verified.linkKeyHex, randomSecret(48), state, new Date().toISOString()).run();
  if (stored.meta.changes !== 1) return failure;
  return signInCallbackPage(SIGNIN_COMPLETED_MESSAGE, { completed: true });
}

/**
 * Reads the completed Google sign-in back exactly once, on the same opaque
 * proof terms as Apple's result route.
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
  if (Object.keys(value).length !== 1
      || typeof state !== "string"
      || !GOOGLE_SIGNIN_STATE_PATTERN.test(state)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const nowIso = new Date().toISOString();
  await deleteExpiredGoogleHandoffs(env.USAGE_MONITOR_DB, nowIso);
  const delivered = await env.USAGE_MONITOR_DB.prepare(
    `UPDATE google_signin_handoffs
        SET delivered_at = ?
      WHERE state = ?
        AND identity_link_key IS NOT NULL
        AND proof IS NOT NULL
        AND delivered_at IS NULL
        AND expires_at > ?
      RETURNING proof`,
  ).bind(nowIso, state, nowIso).first<{ proof: string }>();
  if (delivered) {
    return jsonResponse({
      schemaVersion: "identity-google-result-v0.1",
      proof: delivered.proof,
    });
  }
  const pending = await env.USAGE_MONITOR_DB.prepare(
    `SELECT state FROM google_signin_handoffs
      WHERE state = ?
        AND identity_link_key IS NULL
        AND proof IS NULL
        AND delivered_at IS NULL
        AND expires_at > ?`,
  ).bind(state, nowIso).first<{ state: string }>();
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
  await assertCollectionControl(
    env.USAGE_MONITOR_DB,
    "uploadRegistration",
  );
  const session = await personalSession(request, env);
  assertCsrf(request, session);
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
  if (typeof body.value !== "object"
      || body.value === null
      || Array.isArray(body.value)
      || Object.keys(body.value).length !== 2
      || Reflect.get(body.value, "consentVersion") !== (
        accountScoped
          ? ONGOING_ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION
          : ONGOING_TELEMETRY_CONSENT_VERSION
      )
      || Reflect.get(body.value, "ongoingUpload") !== true) {
    throw new ApiError(400, "BODY_INVALID");
  }
  return jsonResponse(
    await createDevicePairing(
      env.USAGE_MONITOR_DB,
      session.participantId,
      session.sessionId,
      session.consentVersion,
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

async function handleContribution(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  await assertCollectionControl(env.USAGE_MONITOR_DB, "processing");
  if (hasSessionCookie(request.headers.get("cookie"))) {
    throw new ApiError(401, "UPLOAD_AUTH_INVALID");
  }
  const body = await readBoundedJson(request);
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  const bodyBytes = body.bytes.byteLength;
  const scopeDigest = await sha256Hex(body.bytes);
  const authorizationHeader = request.headers.get("authorization");
  const claimed = authorizationHeader?.startsWith("Upload um_device_upload_")
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
  let completed = false;
  try {
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
    const response = Reflect.get(body.value, "schemaVersion") === "telemetry-envelope-v0.1"
      ? await handleTelemetryContribution(request, body, participant, claimed, env)
      : await handleSyntheticContribution(body, participant, claimed, env);
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
    if (!completed) {
      if (claimed.authorizationKind === "device") {
        await abandonDeviceUploadAuthorization(
          env.USAGE_MONITOR_DB,
          claimed.authorizationId,
        );
      } else {
        await abandonUploadAuthorization(
          env.USAGE_MONITOR_DB,
          claimed.authorizationId,
        );
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
  const contributions = await listContributions(env.USAGE_MONITOR_DB, session.participantId);
  if (contributions.length > MAX_SYNTHETIC_CONTRIBUTIONS_PER_PARTICIPANT) {
    throw new ApiError(500, "INTERNAL_ERROR");
  }
  const telemetryTotal = await telemetryContributionCount(
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
  const currentTelemetryTotal = await telemetryContributionCount(
    env.USAGE_MONITOR_DB,
    session.participantId,
  );
  if (currentTelemetryTotal !== telemetryTotal) {
    throw new ApiError(409, "UPLOAD_IN_PROGRESS");
  }
  await finishParticipantDeletion(env.USAGE_MONITOR_DB, session.participantId);
  return jsonResponse({
    deleted: true,
    participantId: session.participantId,
    contributionsDeleted: contributions.length + telemetryTotal,
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

async function handleAdminOverview(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  if (!adminIdentityKeyConfigured(Reflect.get(env, "ADMIN_IDENTITY_LINK_KEY"))) {
    throw new ApiError(503, "ADMIN_NOT_CONFIGURED");
  }
  await adminSession(request, env);
  const reference = new URL(request.url).searchParams.get("diagnosticReference");
  if (reference !== null && !validDiagnosticReference(reference)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  return jsonResponse(
    await readAdminOverview(env.USAGE_MONITOR_DB, env.DELETION_LEDGER, {
      environment: env.ENVIRONMENT,
      enrollmentMode: env.ENROLLMENT_MODE,
      accountScopedIngestMode: env.ACCOUNT_SCOPED_INGEST_MODE,
      diagnosticReference: reference ?? undefined,
    }),
    200,
    { "cache-control": "no-store", vary: "Cookie" },
  );
}

async function handleAdminAction(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  const { session, identityKey } = await adminSession(request, env);
  assertCsrf(request, session);
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
    `SELECT EXISTS (
      SELECT 1 FROM community_weekly_snapshot_rebuilds
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
    if (route.id === "ready") {
      return noStore(await handleReady(request, env));
    }
    if (route.id === "health") {
      if (request.method !== "GET") methodNotAllowed(["GET"]);
      const enrollmentMode = configuredEnrollmentMode(env);
      assertAdmissionBindings(env);
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
      return noStore(jsonResponse({
        status: "ok",
        mode: "synthetic-and-private-telemetry",
        enrollmentMode,
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
        },
      }));
    }
    if (route.id === "unknown_api") throw new ApiError(404, "NOT_FOUND");
    if (route.id !== "asset") {
      const response = await routeApi(request, env, route.id);
      return route.id === "community_stats" ? response : noStore(response);
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
    const handoffPurge = await purgeExpiredIdentityHandoffs(
      env.USAGE_MONITOR_DB,
      // A delayed Cron invocation must still clear handoffs that have expired
      // by the time the Worker actually runs; snapshot construction continues
      // to use the scheduled timestamp for deterministic reporting periods.
      new Date().toISOString(),
    );
    expiredIdentityHandoffsPurged = handoffPurge.purged;
    expiredIdentityHandoffPurgeComplete = handoffPurge.complete;
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
    if (lifecycleComplete
        && quarantineReconciliationComplete
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
      rebuildComplete = !rebuild.remaining;
    } else {
      rebuildComplete = await aggregateRebuildComplete(
        env.USAGE_MONITOR_DB,
      );
    }

    const complete = lifecycleComplete
      && quarantineReconciliationComplete
      && expiredIdentityHandoffPurgeComplete
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
