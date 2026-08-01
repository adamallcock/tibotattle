import {
  assertAdmissionBindings,
  assertAttemptAllowed,
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
  await assertAttemptAllowed(env.ENROLLMENT_RATE_LIMIT, "enrollment");
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
    ? await verifyHostedIdentity(env, identityValue)
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

/**
 * Exchanges a Google authorization code (PKCE, loopback redirect from the
 * local companion) for an ID token, server-side so the browser never talks
 * to Google's token endpoint. Only the id_token is returned; access and
 * refresh tokens from the response are discarded in-request and no identity
 * state is persisted here — enrollment performs verification and linking.
 *
 * The OAuth client is a Desktop/installed client, so Google's token endpoint
 * requires client_secret in addition to the PKCE verifier. That is the whole
 * reason the exchange is server-side: the secret stays in the Worker, is sent
 * only to Google, and is never logged, returned, or named in an error. A
 * deployment missing it fails closed with the same configuration error as a
 * missing client id, which discloses nothing about which value is absent.
 */
async function handleIdentityGoogleExchange(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") methodNotAllowed(["POST"]);
  assertSameOrigin(request);
  assertAdmissionBindings(env);
  await assertAttemptAllowed(env.ENROLLMENT_RATE_LIMIT, "enrollment");
  const clientId = Reflect.get(env, "GOOGLE_OIDC_CLIENT_ID");
  const clientSecret = Reflect.get(env, "GOOGLE_OIDC_CLIENT_SECRET");
  if (typeof clientId !== "string" || clientId.length === 0
      || typeof clientSecret !== "string" || clientSecret.length === 0) {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  const body = await readBoundedJson(request);
  const value = body.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const code = Reflect.get(value, "code");
  const codeVerifier = Reflect.get(value, "codeVerifier");
  const redirectUri = Reflect.get(value, "redirectUri");
  const keys = Object.keys(value);
  const loopbackRedirect = typeof redirectUri === "string"
    && /^http:\/\/127\.0\.0\.1:\d{1,5}\/oauth\/google\/callback$/u.test(redirectUri);
  if (keys.some((key) => !["code", "codeVerifier", "redirectUri"].includes(key))
      || typeof code !== "string" || code.length === 0 || code.length > 2048
      || typeof codeVerifier !== "string"
      || !/^[A-Za-z0-9._~-]{43,128}$/u.test(codeVerifier)
      || !loopbackRedirect) {
    throw new ApiError(400, "BODY_INVALID");
  }
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri as string,
    }),
  });
  if (!tokenResponse.ok) throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  let tokenBody: unknown;
  try {
    tokenBody = await tokenResponse.json();
  } catch {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  const idToken = Reflect.get(tokenBody as object, "id_token");
  if (typeof idToken !== "string" || idToken.length === 0 || idToken.length > 16_384) {
    throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
  }
  return jsonResponse({
    schemaVersion: "identity-google-exchange-v0.1",
    provider: "google",
    idToken,
  });
}

const APPLE_SIGNIN_HANDOFF_TTL_MILLISECONDS = 5 * 60 * 1000;
const MAX_APPLE_CALLBACK_BYTES = 16 * 1024;

/**
 * Apple rejects loopback redirect URIs, so the redirect target is this
 * Worker's own callback route, derived from the request origin rather than
 * from anything a caller supplies. It must be HTTPS: Apple will not register
 * or honor anything else, and the same absolute string has to be replayed on
 * the token exchange.
 */
function appleCallbackUrl(request: Request): string {
  const url = new URL(request.url);
  if (url.protocol !== "https:") {
    throw new ApiError(503, "IDENTITY_CONFIGURATION_INVALID");
  }
  return `${url.origin}/api/v1/identity/apple/callback`;
}

async function deleteExpiredAppleHandoffs(
  db: D1Database,
  nowIso: string,
): Promise<void> {
  await db.prepare(
    "DELETE FROM apple_signin_handoffs WHERE expires_at <= ?",
  ).bind(nowIso).run();
}

function appleCallbackPage(message: string): Response {
  // Entirely inline and asset-free: no script, no style, no image, no link,
  // and no value from the request is interpolated. The authorization code,
  // the id_token, and Apple's optional user payload never reach this markup.
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TiboTattle sign-in</title>
</head>
<body>
<h1>TiboTattle sign-in</h1>
<p>${message}</p>
</body>
</html>
`;
  return new Response(html, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
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
  await assertAttemptAllowed(env.ENROLLMENT_RATE_LIMIT, "enrollment");
  const configuration = appleSignInConfiguration(env);
  const redirectUri = appleCallbackUrl(request);
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
    `INSERT INTO apple_signin_handoffs (state, id_token, created_at, expires_at, consumed_at)
       VALUES (?, NULL, ?, ?, NULL)`,
  ).bind(
    state,
    nowIso,
    new Date(nowMs + APPLE_SIGNIN_HANDOFF_TTL_MILLISECONDS).toISOString(),
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
  const redirectUri = appleCallbackUrl(request);
  const form = await readBoundedForm(request, MAX_APPLE_CALLBACK_BYTES);
  const state = form.get("state");
  const code = form.get("code");
  const failure = appleCallbackPage(
    "Sign-in was not completed. Return to the TiboTattle tab and start the sign-in again.",
  );
  if (typeof state !== "string"
      || !APPLE_SIGNIN_STATE_PATTERN.test(state)
      || form.get("error") !== null
      || typeof code !== "string"
      || code.length === 0) {
    return failure;
  }
  const nowIso = new Date().toISOString();
  const pending = await env.USAGE_MONITOR_DB.prepare(
    `SELECT state FROM apple_signin_handoffs
      WHERE state = ?
        AND id_token IS NULL
        AND consumed_at IS NULL
        AND expires_at > ?`,
  ).bind(state, nowIso).first<{ state: string }>();
  if (!pending) return failure;
  let idToken: string;
  try {
    idToken = await exchangeAppleAuthorizationCode(env, code, redirectUri);
  } catch {
    return failure;
  }
  // Re-checked against the time the exchange finished, not the time it
  // started, so a handoff that expired mid-exchange is never filled.
  const stored = await env.USAGE_MONITOR_DB.prepare(
    `UPDATE apple_signin_handoffs
        SET id_token = ?
      WHERE state = ?
        AND id_token IS NULL
        AND consumed_at IS NULL
        AND expires_at > ?`,
  ).bind(idToken, state, new Date().toISOString()).run();
  if (stored.meta.changes !== 1) return failure;
  return appleCallbackPage("Signed in — return to the TiboTattle tab.");
}

/**
 * Reads the completed sign-in back exactly once. The conditional UPDATE both
 * claims and marks the row, so two concurrent reads cannot both win, and a
 * replayed read after success is indistinguishable from an expired one.
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
  const claimed = await env.USAGE_MONITOR_DB.prepare(
    `UPDATE apple_signin_handoffs
        SET consumed_at = ?
      WHERE state = ?
        AND id_token IS NOT NULL
        AND consumed_at IS NULL
        AND expires_at > ?
      RETURNING id_token AS idToken`,
  ).bind(nowIso, state, nowIso).first<{ idToken: string }>();
  if (claimed) {
    return jsonResponse({
      schemaVersion: "identity-apple-result-v0.1",
      idToken: claimed.idToken,
    });
  }
  const pending = await env.USAGE_MONITOR_DB.prepare(
    `SELECT state FROM apple_signin_handoffs
      WHERE state = ?
        AND id_token IS NULL
        AND consumed_at IS NULL
        AND expires_at > ?`,
  ).bind(state, nowIso).first<{ state: string }>();
  if (pending) throw new ApiError(404, "IDENTITY_RESULT_PENDING");
  throw new ApiError(401, "IDENTITY_TOKEN_INVALID");
}

/**
 * Serves Apple's domain-association file. Apple fetches this exact path over
 * HTTPS to prove the domain belongs to the team behind the Services ID, and
 * it compares the body byte for byte, so the configured value is returned
 * verbatim with no wrapping, trimming, or caching.
 *
 * The contents are configuration, not a secret, but they are also not
 * something this service may invent: until the owner supplies Apple's file the
 * variable is empty and the path answers 404 exactly as an unconfigured route
 * would, rather than publishing a placeholder Apple would reject.
 */
function handleAppleDomainAssociation(request: Request, env: Env): Response {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  const association = Reflect.get(env, "APPLE_DOMAIN_ASSOCIATION");
  if (typeof association !== "string" || association.length === 0) {
    throw new ApiError(404, "NOT_FOUND");
  }
  return new Response(association, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
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
  await assertAttemptAllowed(env.RECOVERY_RATE_LIMIT, "recovery");
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
    await env.QUARANTINE.delete(r2Key);
    await clearPendingQuarantineObject(env.USAGE_MONITOR_DB, {
      contributionId,
      r2Key,
    });
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
          records: item.records.map((record) => ({
            kind: record.record_kind,
            value: JSON.parse(record.record_json) as unknown,
          })),
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

async function handleCommunityStats(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") methodNotAllowed(["GET"]);
  await assertCollectionControl(env.USAGE_MONITOR_DB, "publication");
  return new Response(
    await readLatestCommunityWeeklySnapshot(env.USAGE_MONITOR_DB),
    { headers: JSON_HEADERS },
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
      records: records.map((record) => ({
        kind: record.record_kind,
        value: JSON.parse(record.record_json) as unknown,
      })),
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
    // Not an /api route, but it is dispatched here so every Worker-served
    // path stays in one exhaustively checked switch.
    case "apple_domain_association":
      return handleAppleDomainAssociation(request, env);
    case "enroll":
      return handleEnroll(request, env);
    case "identity_google_exchange":
      return handleIdentityGoogleExchange(request, env);
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
      return await handleReady(request, env);
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
      return jsonResponse({
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
      });
    }
    if (route.id === "unknown_api") throw new ApiError(404, "NOT_FOUND");
    if (route.id !== "asset") return await routeApi(request, env, route.id);
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
    const response = errorResponse(apiError, requestId);
    const allow = allowedHeader(apiError);
    if (!allow) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of new Headers(allow)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
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
  aggregateRebuildComplete: boolean;
  publicationEnabled: boolean | null;
}

export async function runScheduledMaintenance(
  env: Env,
  scheduledTime: number,
): Promise<ScheduledMaintenanceLog> {
  let lifecycleComplete = false;
  let quarantineRetentionComplete = false;
  let restoreReplayComplete = false;
  let quarantineReconciliationComplete = false;
  let rebuildComplete = false;
  let publicationEnabled: boolean | null = null;
  try {
    const lifecycle = await runBackendLifecycle(
      env.USAGE_MONITOR_DB,
      env.DELETION_LEDGER,
      env.QUARANTINE,
      scheduledTime,
    );
    quarantineRetentionComplete =
      lifecycle.quarantineRetentionComplete;
    restoreReplayComplete = lifecycle.restoreReplayComplete;
    lifecycleComplete = quarantineRetentionComplete
      && restoreReplayComplete;

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
      await buildCommunityWeeklySnapshot(
        env.USAGE_MONITOR_DB,
        scheduledTime,
      );
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
      aggregateRebuildComplete: rebuildComplete,
      publicationEnabled,
    };
    console.error(JSON.stringify(log));
    throw error;
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
