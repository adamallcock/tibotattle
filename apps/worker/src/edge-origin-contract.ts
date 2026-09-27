/**
 * Edge/origin transport contract.
 *
 * The production Worker can run as a thin edge (EDGE_UPSTREAM_MODE
 * worker|fenced|gcp) in front of an IAM-private Cloud Run origin. This module
 * is the single contract both sides import: the edge in the Workers runtime
 * and the origin boundary in Node. A deployed edge and origin must carry an
 * identical copy of this file, so it stays free of incidental churn and
 * self-contained: no imports, and only platform globals that both runtimes
 * share (URL, TextDecoder, atob).
 *
 * No request header, derivation or pattern for a per-address value exists
 * here. The raw client address and anything derived from it stay at the edge.
 */

// ---------------------------------------------------------------------------
// Validated strings

/**
 * A string one of this module's validators accepted. The brand lets `true`
 * narrow an unknown or nullable input to a string, while `false` leaves a
 * plain string input typed as a string (a bare `value is string` would narrow
 * it to never).
 */
type Validated<Kind extends string> = string & { readonly __edgeOriginContract: Kind };
export type EdgeRequestId = Validated<"EdgeRequestId">;
export type GoogleCallbackQuery = Validated<"GoogleCallbackQuery">;
export type EdgeOriginAudience = Validated<"EdgeOriginAudience">;
export type EdgeServiceAccountEmail = Validated<"EdgeServiceAccountEmail">;

// ---------------------------------------------------------------------------
// Modes and hosts

export const EDGE_UPSTREAM_MODES = Object.freeze(["worker", "fenced", "gcp"] as const);
export type EdgeUpstreamMode = (typeof EDGE_UPSTREAM_MODES)[number];

/** Exact match only; anything else (absent, empty, cased, padded) is null. */
export function parseEdgeUpstreamMode(value: unknown): EdgeUpstreamMode | null {
  return typeof value === "string" && (EDGE_UPSTREAM_MODES as readonly string[]).includes(value)
    ? value as EdgeUpstreamMode
    : null;
}

export const EDGE_HOST_KINDS = Object.freeze(["apex", "admin"] as const);
export type EdgeHostKind = (typeof EDGE_HOST_KINDS)[number];

// ---------------------------------------------------------------------------
// Headers

export const EDGE_HEADERS = Object.freeze({
  host: "x-tibotattle-edge-host",
  admission: "x-tibotattle-edge-admission",
  requestId: "x-tibotattle-edge-request-id",
  callbackQuery: "x-tibotattle-google-callback-query",
  deferredAdmission: "x-tibotattle-edge-deferred-admission",
  invokerToken: "x-serverless-authorization",
  originMarker: "x-tibotattle-origin",
} as const);

/** The only x-tibotattle-* request headers the origin accepts. */
export const EDGE_CONTRACT_REQUEST_HEADERS = Object.freeze([
  EDGE_HEADERS.host,
  EDGE_HEADERS.admission,
  EDGE_HEADERS.requestId,
  EDGE_HEADERS.callbackQuery,
] as const);

/** Client request headers the edge copies to the origin on both hosts. */
export const FORWARDED_REQUEST_HEADERS = Object.freeze([
  "content-type",
  "content-length",
  "authorization",
  "cookie",
  "origin",
  "sec-fetch-site",
  "x-usage-monitor-csrf",
  "x-usage-monitor-admin",
  "x-previous-device-authorization",
] as const);

/** Client request headers copied to the origin on the admin host only. */
export const ADMIN_ONLY_FORWARDED_REQUEST_HEADERS = Object.freeze([
  "cf-access-jwt-assertion",
] as const);

/** Request headers read only by edge-local handlers; never forwarded. */
export const EDGE_LOCAL_ONLY_REQUEST_HEADERS = Object.freeze([
  "x-usage-monitor-release-timestamp",
  "x-usage-monitor-release-nonce",
  "x-usage-monitor-release-signature",
  "cf-connecting-ip",
] as const);

/** Origin response headers the edge never passes through to the client. */
export const DROPPED_RESPONSE_HEADERS = Object.freeze([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "server",
  "via",
  "alt-svc",
  "x-cloud-trace-context",
  "traceparent",
  EDGE_HEADERS.originMarker,
  EDGE_HEADERS.deferredAdmission,
] as const);

// ---------------------------------------------------------------------------
// Edge admission codec

export const EDGE_ADMISSION_PURPOSES = Object.freeze([
  "enrollment",
  "sign_in_start",
  "recovery",
  "device_disconnect",
  "device_credential_renew",
  "device_sync",
  "device_sync_credential",
  "accountless_ownership",
  "accountless_renewal",
  "public_aggregate_read",
  "upload_ingress",
] as const);
export type EdgeAdmissionPurpose = (typeof EDGE_ADMISSION_PURPOSES)[number];

export const EDGE_ADMISSION_OUTCOMES = Object.freeze(["allowed", "limited", "unavailable"] as const);
export type EdgeAdmissionOutcome = (typeof EDGE_ADMISSION_OUTCOMES)[number];

export interface EdgeAdmission {
  readonly purpose: EdgeAdmissionPurpose;
  readonly outcome: EdgeAdmissionOutcome;
}

const EDGE_ADMISSION_VERSION = "v1";
const MAX_EDGE_ADMISSION_LENGTH = 96;

/** The origin asks the edge to replay a failed device credential's attempt limits. */
export const EDGE_DEFERRED_DEVICE_SYNC_ATTEMPT = "v1;device_sync";

/** Accepts only the exact response token; the header is never client-authored. */
export function isEdgeDeferredDeviceSyncAttempt(value: unknown): boolean {
  return value === EDGE_DEFERRED_DEVICE_SYNC_ATTEMPT;
}

function isEdgeAdmissionPurpose(value: unknown): value is EdgeAdmissionPurpose {
  return typeof value === "string" && (EDGE_ADMISSION_PURPOSES as readonly string[]).includes(value);
}

function isEdgeAdmissionOutcome(value: unknown): value is EdgeAdmissionOutcome {
  return typeof value === "string" && (EDGE_ADMISSION_OUTCOMES as readonly string[]).includes(value);
}

/** Encodes 'v1;<purpose>;<outcome>'. Unknown values are a programming error. */
export function encodeEdgeAdmission(admission: EdgeAdmission): string {
  if (admission === null || typeof admission !== "object"
      || !isEdgeAdmissionPurpose(admission.purpose)
      || !isEdgeAdmissionOutcome(admission.outcome)) {
    throw new TypeError("EDGE_ADMISSION_INVALID");
  }
  return `${EDGE_ADMISSION_VERSION};${admission.purpose};${admission.outcome}`;
}

/** Strict decode: exactly three fields, known values only, else null. */
export function decodeEdgeAdmission(value: unknown): EdgeAdmission | null {
  if (typeof value !== "string" || value.length > MAX_EDGE_ADMISSION_LENGTH) return null;
  const fields = value.split(";");
  if (fields.length !== 3 || fields[0] !== EDGE_ADMISSION_VERSION) return null;
  const [, purpose, outcome] = fields;
  if (!isEdgeAdmissionPurpose(purpose) || !isEdgeAdmissionOutcome(outcome)) return null;
  return Object.freeze({ purpose, outcome });
}

// ---------------------------------------------------------------------------
// Request id

const EDGE_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** A lowercase RFC 9562 version 4 UUID, as crypto.randomUUID() produces. */
export function isEdgeRequestId(value: unknown): value is EdgeRequestId {
  return typeof value === "string" && EDGE_REQUEST_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Google callback query

export const GOOGLE_CALLBACK_PATH = "/api/v1/identity/google/callback";
export const MAX_GOOGLE_CALLBACK_URL_LENGTH = 8_192;

/**
 * Mirrors the Cloud Run request boundary's callback-query check exactly
 * (cloud-run/request-boundary.mjs buildPublicGoogleRequestUrl), including its
 * acceptance of a bare '?'. The edge sends the header only when this holds, so
 * the origin never receives a query it would refuse.
 */
export function validGoogleCallbackQuery(value: unknown): value is GoogleCallbackQuery {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= MAX_GOOGLE_CALLBACK_URL_LENGTH
    && value.startsWith("?")
    && !/[\u0000-\u0020\u007f#\\]/u.test(value);
}

// ---------------------------------------------------------------------------
// Cloud Run invoker claims

export interface CloudRunInvokerClaims {
  readonly email: string;
  readonly emailVerified: boolean;
  readonly audiences: readonly string[];
  readonly expiresAt: number;
}

/**
 * Allowed clock difference between the token issuer and the reader, in
 * seconds. A token is accepted while expiresAt > now - skew and its issue
 * time, when present, is not later than now + skew.
 */
export const EDGE_INVOKER_CLOCK_SKEW_SECONDS = 60;

const MAX_INVOKER_HEADER_LENGTH = 8_192;
const INVOKER_BEARER_PREFIX = "Bearer ";
const BASE64URL_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/u;
const INVOKER_EMAIL_PATTERN = /^[!-?A-~]{1,64}@[!-?A-~]{1,189}$/u;
const MAX_INVOKER_AUDIENCES = 16;
// Printable ASCII, 1-256 characters, without leading or trailing spaces.
const AUDIENCE_PATTERN = /^[!-~](?:[ -~]{0,254}[!-~])?$/u;

type JsonObject = Record<string, unknown>;

function decodeBase64UrlJsonObject(segment: string): JsonObject | null {
  if (!BASE64URL_SEGMENT_PATTERN.test(segment) || segment.length % 4 === 1) return null;
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const parsed: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
  );
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as JsonObject
    : null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readInvokerAudiences(value: unknown): readonly string[] | null {
  const audiences = typeof value === "string" ? [value] : value;
  if (!Array.isArray(audiences) || audiences.length === 0
      || audiences.length > MAX_INVOKER_AUDIENCES) return null;
  const result: string[] = [];
  for (const audience of audiences) {
    if (typeof audience !== "string" || !AUDIENCE_PATTERN.test(audience)) return null;
    result.push(audience);
  }
  return Object.freeze(result);
}

function parseInvokerClaims(value: unknown, nowSeconds: unknown): CloudRunInvokerClaims | null {
  if (typeof nowSeconds !== "number" || !Number.isFinite(nowSeconds) || nowSeconds < 0) return null;
  if (typeof value !== "string" || value.length > MAX_INVOKER_HEADER_LENGTH
      || !value.startsWith(INVOKER_BEARER_PREFIX)) return null;
  const segments = value.slice(INVOKER_BEARER_PREFIX.length).split(".");
  if (segments.length !== 3) return null;
  const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
  // Cloud Run's front end verifies the token before delivery and may replace
  // the signature, so only its shape is checked; header and payload must be
  // JSON objects.
  if (!BASE64URL_SEGMENT_PATTERN.test(signatureSegment)) return null;
  if (decodeBase64UrlJsonObject(headerSegment) === null) return null;
  const payload = decodeBase64UrlJsonObject(payloadSegment);
  if (payload === null) return null;

  const email = payload.email;
  if (typeof email !== "string" || email.length > 254 || !INVOKER_EMAIL_PATTERN.test(email)) {
    return null;
  }
  const verified = payload.email_verified;
  if (verified !== undefined && typeof verified !== "boolean") return null;
  const audiences = readInvokerAudiences(payload.aud);
  if (audiences === null) return null;
  const expiresAt = payload.exp;
  if (!isNonNegativeSafeInteger(expiresAt)
      || expiresAt <= nowSeconds - EDGE_INVOKER_CLOCK_SKEW_SECONDS) {
    return null;
  }
  // Google-issued ID tokens carry `iat` and Cloud Run's front end verifies
  // the token before delivery, so `iat` is validated when present but not
  // required.
  const issuedAt = payload.iat;
  if (issuedAt !== undefined
      && (!isNonNegativeSafeInteger(issuedAt)
        || issuedAt >= expiresAt
        || issuedAt > nowSeconds + EDGE_INVOKER_CLOCK_SKEW_SECONDS)) {
    return null;
  }
  return Object.freeze({ email, emailVerified: verified === true, audiences, expiresAt });
}

/**
 * Decodes the claims Cloud Run delivers in x-serverless-authorization after
 * its IAM front end has verified the token: 'Bearer ' plus three base64url
 * segments, at most 8192 characters. The payload must carry `email`, `aud`
 * (a string or 1-16 strings) and integer `exp`. When present,
 * `email_verified` must be a boolean and `iat` an integer before `exp`.
 * Returns null for anything malformed or outside the clock-skew window;
 * never throws and never retains the value. Audience, verification and
 * identity decisions belong to the caller.
 */
export function parseCloudRunInvokerClaims(
  value: unknown,
  nowSeconds: number,
): CloudRunInvokerClaims | null {
  try {
    return parseInvokerClaims(value, nowSeconds);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Edge origin configuration

export interface EdgeOriginConfiguration {
  readonly upstreamOrigin: string;
  readonly audience: string;
  readonly invokerServiceAccount: string;
  readonly upstreamHeadersTimeoutSeconds: number;
}

const RUN_APP_HOSTNAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+run\.app$/u;
const SERVICE_ACCOUNT_EMAIL_PATTERN
  = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/u;
const MIN_UPSTREAM_HEADERS_TIMEOUT_SECONDS = 5;
const MAX_UPSTREAM_HEADERS_TIMEOUT_SECONDS = 300;
const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_SECONDS = 100;

/**
 * Returns `value` when it is a canonical https origin (no credentials, port,
 * path, query or fragment) whose host is a lowercase DNS name under run.app,
 * else null; never throws. Use it for every setting that names a Cloud Run
 * service origin.
 */
export function canonicalRunAppOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== ""
      || url.port !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== ""
      || url.origin !== value || url.hostname.length > 253
      || !RUN_APP_HOSTNAME_PATTERN.test(url.hostname)) {
    return null;
  }
  return url.origin;
}

/** An ID-token audience: 1-256 printable ASCII characters, no outer spaces. */
export function isEdgeOriginAudience(value: unknown): value is EdgeOriginAudience {
  return typeof value === "string" && AUDIENCE_PATTERN.test(value);
}

/**
 * A user-managed service account email (6-30 character account id and
 * project id), as used for the edge invoker and any origin verifier.
 */
export function isEdgeServiceAccountEmail(value: unknown): value is EdgeServiceAccountEmail {
  return typeof value === "string" && SERVICE_ACCOUNT_EMAIL_PATTERN.test(value);
}

function upstreamHeadersTimeoutSeconds(value: unknown): number | null {
  if (value === undefined) return DEFAULT_UPSTREAM_HEADERS_TIMEOUT_SECONDS;
  let seconds: number;
  if (typeof value === "string") {
    if (!/^[1-9][0-9]{0,2}$/u.test(value)) return null;
    seconds = Number(value);
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    seconds = value;
  } else {
    return null;
  }
  return seconds >= MIN_UPSTREAM_HEADERS_TIMEOUT_SECONDS
    && seconds <= MAX_UPSTREAM_HEADERS_TIMEOUT_SECONDS ? seconds : null;
}

function readEdgeOriginConfiguration(get: (name: string) => unknown): EdgeOriginConfiguration | null {
  const upstreamOrigin = canonicalRunAppOrigin(get("EDGE_UPSTREAM_ORIGIN"));
  const audience = get("EDGE_ORIGIN_AUDIENCE");
  const invokerServiceAccount = get("EDGE_INVOKER_SERVICE_ACCOUNT");
  const timeoutSeconds = upstreamHeadersTimeoutSeconds(get("EDGE_UPSTREAM_HEADERS_TIMEOUT_SECONDS"));
  if (upstreamOrigin === null
      || !isEdgeOriginAudience(audience)
      || !isEdgeServiceAccountEmail(invokerServiceAccount)
      || timeoutSeconds === null) {
    return null;
  }
  return Object.freeze({
    upstreamOrigin,
    audience,
    invokerServiceAccount,
    upstreamHeadersTimeoutSeconds: timeoutSeconds,
  });
}

/**
 * Validates the edge's upstream settings read through `get` (for example
 * `(name) => Reflect.get(env, name)`). Returns a frozen configuration, or null
 * for any missing or malformed value; never throws.
 */
export function parseEdgeOriginConfiguration(
  get: (name: string) => unknown,
): EdgeOriginConfiguration | null {
  if (typeof get !== "function") return null;
  try {
    return readEdgeOriginConfiguration(get);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Constants

export const EDGE_FENCE_RETRY_AFTER_SECONDS = 300;
export const EDGE_UNAVAILABLE_RETRY_AFTER_SECONDS = 60;
export const EDGE_MAX_FORWARD_BODY_BYTES = 8_388_608;
export const EDGE_MAX_OVERVIEW_MERGE_BYTES = 4_194_304;
export const EDGE_MIN_CLIENT_KEY_SECRET_LENGTH = 32;
export const EDGE_NOT_CONFIGURED = "EDGE_NOT_CONFIGURED";
export const EDGE_ORIGIN_UNAVAILABLE = "EDGE_ORIGIN_UNAVAILABLE";
export const ORIGIN_BOUNDARY_ERROR_BODY = "{\"error\":\"HOST_REQUEST_UNAVAILABLE\"}";
