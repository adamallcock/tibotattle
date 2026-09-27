/**
 * Cloud Run origin boundary behind the Cloudflare edge (gcp mode).
 *
 * The origin is IAM-private: Cloud Run's front end admits only requests whose
 * Google ID token names an allowed invoker, verifies it and delivers its
 * claims in x-serverless-authorization. This boundary is a transport layer
 * that serves no route (EDGE_ORIGIN_DISPATCH_PATHNAMES is empty). For every
 * raw request it:
 * 1. checks the delivered claims: the configured audience, a verified email
 *    and an unexpired token whose email is the edge invoker or one of 0-4
 *    verifier accounts;
 * 2. limits a verifier to a plain GET of /api/health or /api/ready with an
 *    empty query and no x-tibotattle-* header;
 * 3. for the invoker, accepts only the contract's x-tibotattle-* request
 *    headers (src/edge-origin-contract.ts): a valid host kind (apex|admin)
 *    and request id, an optional decodable admission outcome, and a Google
 *    callback query only on the apex callback route; the callback route
 *    never carries a raw query, with or without that header;
 * 4. rebuilds the request on the public origin (the admin host is
 *    'admin.' + the public hostname) by assigning the raw path and query to
 *    that base, so no path can move it to another host, with at most 16384
 *    characters;
 * 5. copies only FORWARDED_REQUEST_HEADERS, plus cf-access-jwt-assertion on
 *    the admin host: every cf-* (so no cf-connecting-ip ever reaches inner),
 *    x-forwarded-*, the token and every x-tibotattle-* header stay here;
 * 6. records {requestId, hostKind} for the rebuilt Request
 *    (edgeRequestContext) and runs inner inside the admission replay scope
 *    (postgres-edge-admission-limiters.mjs), which reports a failed device
 *    bearer that replayed the post-verification attempt pair;
 * 7. when that report accompanies a 401, adds the response-only deferred
 *    admission token for the edge to charge RECOVERY then CLIENT_ATTEMPT. A
 *    deferred report with any other status becomes 500 INTERNAL_ERROR;
 * 8. marks every response it returns with x-tibotattle-origin: 1, keeping each
 *    Set-Cookie separate; a throw from inner answers the Worker's
 *    500 INTERNAL_ERROR envelope.
 *
 * Any failure in steps 1-5 answers one constant, unmarked 421 with
 * ORIGIN_BOUNDARY_ERROR_BODY and connection: close, without reading the
 * request body, so every refusal looks the same and the edge maps it to its
 * own 503. Nothing here logs, buffers a body or keeps the token.
 */

import { JSON_HEADERS } from "../src/constants.ts";
import {
  ADMIN_ONLY_FORWARDED_REQUEST_HEADERS,
  EDGE_CONTRACT_REQUEST_HEADERS,
  EDGE_DEFERRED_DEVICE_SYNC_ATTEMPT,
  EDGE_HEADERS,
  EDGE_HOST_KINDS,
  EDGE_INVOKER_CLOCK_SKEW_SECONDS,
  FORWARDED_REQUEST_HEADERS,
  GOOGLE_CALLBACK_PATH,
  ORIGIN_BOUNDARY_ERROR_BODY,
  decodeEdgeAdmission,
  isEdgeOriginAudience,
  isEdgeRequestId,
  isEdgeServiceAccountEmail,
  parseCloudRunInvokerClaims,
  validGoogleCallbackQuery,
} from "../src/edge-origin-contract.ts";
import { ApiError, errorResponse } from "../src/errors.ts";

/** This boundary claims no route; the production registry owns all of them. */
export const EDGE_ORIGIN_DISPATCH_PATHNAMES = Object.freeze([]);

/** The only paths a verifier account may read (plain GET, empty query). */
export const EDGE_ORIGIN_VERIFIER_PATHNAMES = Object.freeze(["/api/health", "/api/ready"]);

export const MAX_EDGE_ORIGIN_VERIFIER_ACCOUNTS = 4;
export const MAX_EDGE_ORIGIN_URL_LENGTH = 16_384;

/**
 * The constant refusal's headers: the Worker JSON headers (JSON, no-store,
 * no-referrer, nosniff) plus connection: close, and never the origin marker.
 */
export const ORIGIN_BOUNDARY_ERROR_HEADERS = Object.freeze({
  ...JSON_HEADERS,
  connection: "close",
});

const EDGE_HEADER_PREFIX = "x-tibotattle-";
const ORIGIN_MARKER_VALUE = "1";
const ADMIN_HOST_PREFIX = "admin.";

/** The edge context of each rebuilt Request, keyed on that exact object. */
const edgeContexts = new WeakMap();

function configurationError(code) {
  return Object.assign(new TypeError(code), { code });
}

/** Thrown inside the boundary checks only; always answered as the 421. */
class OriginBoundaryRefusal extends Error {}

function refuse() {
  throw new OriginBoundaryRefusal();
}

function originBoundaryRefusalResponse() {
  return new Response(ORIGIN_BOUNDARY_ERROR_BODY, {
    status: 421,
    headers: ORIGIN_BOUNDARY_ERROR_HEADERS,
  });
}

function canonicalPublicOrigin(value) {
  if (typeof value !== "string" || value.length > 512) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== ""
      || url.port !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== ""
      || url.origin !== value || url.hostname.startsWith(ADMIN_HOST_PREFIX)) {
    return null;
  }
  return url;
}

function verifierAccounts(value, invokerServiceAccount) {
  const accounts = value === undefined ? [] : value;
  if (!Array.isArray(accounts) || accounts.length > MAX_EDGE_ORIGIN_VERIFIER_ACCOUNTS
      || accounts.some((account) => !isEdgeServiceAccountEmail(account)
        || account === invokerServiceAccount)
      || new Set(accounts).size !== accounts.length) {
    throw configurationError("EDGE_ORIGIN_VERIFIER_ACCOUNTS_INVALID");
  }
  return Object.freeze([...accounts]);
}

function nowSecondsFrom(clock) {
  const milliseconds = clock();
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) {
    refuse();
  }
  return Math.floor(milliseconds / 1000);
}

/** The caller role the delivered claims prove, or a refusal. */
function callerRole(headers, config) {
  const token = headers.get(EDGE_HEADERS.invokerToken);
  if (token === null) refuse();
  const nowSeconds = nowSecondsFrom(config.clock);
  // Duplicate headers arrive joined with ', ', which never parses.
  const claims = parseCloudRunInvokerClaims(token, nowSeconds);
  if (claims === null
      || claims.emailVerified !== true
      || claims.audiences.length !== 1
      || claims.audiences[0] !== config.audience
      || !(claims.expiresAt > nowSeconds - EDGE_INVOKER_CLOCK_SKEW_SECONDS)) {
    refuse();
  }
  if (claims.email === config.invokerServiceAccount) return "invoker";
  if (config.verifierServiceAccounts.includes(claims.email)) return "verifier";
  return refuse();
}

function edgeHeaderNames(headers) {
  const names = new Set();
  for (const name of headers.keys()) {
    if (name.startsWith(EDGE_HEADER_PREFIX)) names.add(name);
  }
  return names;
}

function rawUrlOf(request) {
  let url;
  try { url = new URL(request.url); } catch { refuse(); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.pathname.startsWith("/")) {
    refuse();
  }
  return url;
}

/** Verifier: a plain GET of health or readiness, rebuilt on the apex. */
function verifierEdge(request, rawUrl, edgeNames) {
  if (request.method !== "GET" || edgeNames.size !== 0 || rawUrl.search !== ""
      || !EDGE_ORIGIN_VERIFIER_PATHNAMES.includes(rawUrl.pathname)) {
    refuse();
  }
  return { hostKind: "apex", requestId: null, admission: null, callbackQuery: null };
}

/** Invoker: exactly the contract headers, each once and valid. */
function invokerEdge(request, rawUrl, edgeNames) {
  for (const name of edgeNames) {
    if (!EDGE_CONTRACT_REQUEST_HEADERS.includes(name)) refuse();
  }
  const { headers } = request;
  // Headers.get joins repeated values with ', ', which no valid value
  // contains, so a repeated header is refused by its own check.
  const hostKind = headers.get(EDGE_HEADERS.host);
  if (!EDGE_HOST_KINDS.includes(hostKind)) refuse();
  const requestId = headers.get(EDGE_HEADERS.requestId);
  if (!isEdgeRequestId(requestId)) refuse();
  let admission = null;
  if (headers.has(EDGE_HEADERS.admission)) {
    admission = decodeEdgeAdmission(headers.get(EDGE_HEADERS.admission));
    if (admission === null) refuse();
  }
  // The edge never forwards the callback's own query: the OAuth code and state
  // travel only in the callback header, and on the admin host not at all. So
  // a raw query on the callback path is refused with or without that header,
  // as request-boundary.mjs refuses it: an edge that puts the query on the
  // origin URL (and so in the origin's request logs) fails at once instead of
  // completing the sign-in.
  if (rawUrl.pathname === GOOGLE_CALLBACK_PATH && rawUrl.search !== "") refuse();
  let callbackQuery = null;
  if (headers.has(EDGE_HEADERS.callbackQuery)) {
    callbackQuery = headers.get(EDGE_HEADERS.callbackQuery);
    if (hostKind !== "apex" || request.method !== "GET"
        || rawUrl.pathname !== GOOGLE_CALLBACK_PATH
        || !validGoogleCallbackQuery(callbackQuery)) {
      refuse();
    }
  }
  return { hostKind, requestId, admission, callbackQuery };
}

function rebuiltUrl(rawUrl, edge, origins) {
  const base = edge.hostKind === "admin" ? origins.admin : origins.apex;
  const url = new URL(base);
  // Field assignment keeps the configured authority: a raw path such as
  // '//other.example/x' stays a path on this origin.
  url.pathname = rawUrl.pathname;
  url.search = edge.callbackQuery ?? rawUrl.search;
  const href = url.href;
  if (url.origin !== base || !url.pathname.startsWith("/")
      || href.length > MAX_EDGE_ORIGIN_URL_LENGTH) {
    refuse();
  }
  return href;
}

function forwardedHeaders(rawHeaders, hostKind) {
  const headers = new Headers();
  const names = hostKind === "admin"
    ? [...FORWARDED_REQUEST_HEADERS, ...ADMIN_ONLY_FORWARDED_REQUEST_HEADERS]
    : FORWARDED_REQUEST_HEADERS;
  for (const name of names) {
    const value = rawHeaders.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/** Steps 1-5 and the rebuilt Request, or an OriginBoundaryRefusal. */
function admittedRequest(rawRequest, config) {
  if (!(rawRequest instanceof Request)) refuse();
  const role = callerRole(rawRequest.headers, config);
  const rawUrl = rawUrlOf(rawRequest);
  const edgeNames = edgeHeaderNames(rawRequest.headers);
  const edge = role === "verifier"
    ? verifierEdge(rawRequest, rawUrl, edgeNames)
    : invokerEdge(rawRequest, rawUrl, edgeNames);
  const url = rebuiltUrl(rawUrl, edge, config.origins);
  const bodyless = rawRequest.method === "GET" || rawRequest.method === "HEAD";
  let request;
  try {
    request = new Request(url, {
      method: rawRequest.method,
      headers: forwardedHeaders(rawRequest.headers, edge.hostKind),
      body: bodyless ? null : rawRequest.body,
      duplex: "half",
      signal: rawRequest.signal,
    });
  } catch {
    refuse();
  }
  if (edge.requestId !== null) {
    edgeContexts.set(request, Object.freeze({ requestId: edge.requestId, hostKind: edge.hostKind }));
  }
  return { request, requestId: edge.requestId, admission: edge.admission };
}

function internalError(requestId) {
  return errorResponse(new ApiError(500, "INTERNAL_ERROR"), requestId ?? crypto.randomUUID());
}

function markedResponse(response, deferredAttempt = false) {
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie" && name !== EDGE_HEADERS.deferredAdmission) headers.append(name, value);
  }
  for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
  headers.set(EDGE_HEADERS.originMarker, ORIGIN_MARKER_VALUE);
  if (deferredAttempt) {
    headers.set(EDGE_HEADERS.deferredAdmission, EDGE_DEFERRED_DEVICE_SYNC_ATTEMPT);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The edge context recorded for a Request this boundary rebuilt:
 * {requestId, hostKind}, frozen. Undefined for any other object, for a clone,
 * and for a verifier request (which carries no edge request id).
 */
export function edgeRequestContext(request) {
  if (request === null || typeof request !== "object") return undefined;
  return edgeContexts.get(request);
}

function edgeServedAssetNotFound(request) {
  const requestId = edgeRequestContext(request)?.requestId ?? crypto.randomUUID();
  return errorResponse(new ApiError(404, "NOT_FOUND"), requestId);
}

/**
 * The ASSETS binding for the origin handler. The edge serves the public
 * release site and the admin UI itself, so any asset request that reaches
 * the origin answers the Worker's JSON 404 NOT_FOUND with no-store.
 */
export const edgeServedAssets = Object.freeze({
  async fetch(request) {
    return edgeServedAssetNotFound(request);
  },
});

/**
 * Create the boundary. inner is the production request handler
 * (async (request) => Response); admission is createEdgeAdmissionLimiters();
 * clock returns epoch milliseconds (Date.now by default).
 */
export function createEdgeOriginDispatch({
  invokerServiceAccount,
  verifierServiceAccounts,
  audience,
  publicOrigin,
  admission,
  inner,
  clock = Date.now,
} = {}) {
  if (!isEdgeServiceAccountEmail(invokerServiceAccount)) {
    throw configurationError("EDGE_ORIGIN_INVOKER_INVALID");
  }
  const verifiers = verifierAccounts(verifierServiceAccounts, invokerServiceAccount);
  if (!isEdgeOriginAudience(audience)) throw configurationError("EDGE_ORIGIN_AUDIENCE_INVALID");
  const apexUrl = canonicalPublicOrigin(publicOrigin);
  if (apexUrl === null) throw configurationError("EDGE_ORIGIN_PUBLIC_ORIGIN_INVALID");
  if (admission === null || typeof admission !== "object"
      || typeof admission.run !== "function"
      || typeof admission.runWithReport !== "function") {
    throw configurationError("EDGE_ORIGIN_ADMISSION_INVALID");
  }
  if (typeof inner !== "function") throw configurationError("EDGE_ORIGIN_INNER_INVALID");
  if (typeof clock !== "function") throw configurationError("EDGE_ORIGIN_CLOCK_INVALID");
  const config = Object.freeze({
    invokerServiceAccount,
    verifierServiceAccounts: verifiers,
    audience,
    origins: Object.freeze({
      apex: apexUrl.origin,
      admin: new URL(`https://${ADMIN_HOST_PREFIX}${apexUrl.hostname}`).origin,
    }),
    clock,
  });

  return async function dispatchEdgeOrigin(rawRequest) {
    let admitted;
    try {
      admitted = admittedRequest(rawRequest, config);
    } catch {
      return originBoundaryRefusalResponse();
    }
    let response;
    try {
      const replayed = await admission.runWithReport(
        admitted.admission,
        () => inner(admitted.request),
      );
      if (replayed === null || typeof replayed !== "object"
          || typeof replayed.deferredAttempt !== "boolean") {
        throw new TypeError("EDGE_ORIGIN_ADMISSION_REPORT_INVALID");
      }
      response = replayed.result;
      if (!(response instanceof Response)) throw new TypeError("EDGE_ORIGIN_RESPONSE_INVALID");
      if (replayed.deferredAttempt && response.status !== 401) {
        return markedResponse(internalError(admitted.requestId));
      }
      return markedResponse(response, replayed.deferredAttempt);
    } catch {
      return markedResponse(internalError(admitted.requestId));
    }
  };
}
